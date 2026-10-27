import { randomUUID } from 'node:crypto';
import { Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { AUTH_ERRORS } from '../../common/consts/message';
import { runSerializableTransaction } from '../../common/prisma/transaction.util';
import {
  PRISMA_SERVICE_TOKEN,
  type ExtendedPrismaClient,
} from '../../common/prisma/prisma.service';
import type {
  AuthRefreshTokenPayload,
  AuthRequestMetadata,
} from '../../common/types';
import { AuthTokenService } from './auth-token.service';

const SESSION_REVOKE_REASONS = {
  LOGOUT: 'LOGOUT',
  REFRESH_ROTATED: 'REFRESH_ROTATED',
  REFRESH_REUSE: 'REFRESH_REUSE',
  PASSWORD_RESET: 'PASSWORD_RESET',
  EMPLOYEE_DISABLED: 'EMPLOYEE_DISABLED',
  GOOGLE_UNLINKED: 'GOOGLE_UNLINKED',
} as const;

const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;

@Injectable()
export class AuthSessionService {
  constructor(
    @Inject(PRISMA_SERVICE_TOKEN)
    private readonly prisma: ExtendedPrismaClient,
    private readonly authTokenService: AuthTokenService,
  ) {}

  async createSession(
    employee: { id: string; email: string },
    metadata: AuthRequestMetadata,
    googleSubject?: string,
    expectedPasswordHash?: string,
  ) {
    const sessionId = randomUUID();
    const familyId = randomUUID();
    const tokens = await this.authTokenService.createTokenPair({
      employeeId: employee.id,
      email: employee.email,
      sessionId,
      familyId,
    });

    const data = {
      id: sessionId,
      familyId,
      employeeId: employee.id,
      refreshTokenHash: this.authTokenService.hashToken(tokens.refreshToken),
      expiresAt: this.getRefreshExpiry(),
      ...this.normalizeMetadata(metadata),
    };
    if (googleSubject) {
      await this.prisma.$transaction(async (tx) => {
        const linked = await tx.$queryRaw<Array<{ id: string }>>`
          SELECT id FROM "Employee"
          WHERE id = ${employee.id} AND "googleSubject" = ${googleSubject}
            AND "isActive" = true AND "deletedAt" IS NULL
          FOR SHARE
        `;
        if (!linked.length) {
          throw new UnauthorizedException(AUTH_ERRORS.INVALID_CREDENTIALS);
        }
        await tx.authSession.create({ data });
      });
    } else if (expectedPasswordHash !== undefined) {
      await this.prisma.$transaction(async (tx) => {
        const verified = await tx.$queryRaw<Array<{ id: string }>>`
          SELECT id FROM "Employee"
          WHERE id = ${employee.id} AND "password" = ${expectedPasswordHash}
            AND "isActive" = true AND "deletedAt" IS NULL
          FOR SHARE
        `;
        if (!verified.length) {
          throw new UnauthorizedException(AUTH_ERRORS.INVALID_CREDENTIALS);
        }
        await tx.authSession.create({ data });
      });
    } else {
      await this.prisma.authSession.create({ data });
    }

    return tokens;
  }

  async rotate(refreshToken: string, metadata: AuthRequestMetadata) {
    const payload =
      await this.authTokenService.verifyRefreshToken(refreshToken);
    const nextSessionId = randomUUID();
    const nextTokens = await this.authTokenService.createTokenPair({
      employeeId: payload.sub,
      email: payload.email,
      sessionId: nextSessionId,
      familyId: payload.familyId,
    });
    const outcome = await runSerializableTransaction(
      this.prisma,
      async (tx) => {
        const now = new Date();
        const current = await tx.authSession.findUnique({
          where: { id: payload.sid },
          include: {
            employee: {
              select: {
                id: true,
                email: true,
                isActive: true,
                deletedAt: true,
              },
            },
          },
        });

        const isValid =
          current?.employeeId === payload.sub &&
          current.familyId === payload.familyId &&
          current.employee.isActive &&
          !current.employee.deletedAt &&
          current.employee.email === payload.email &&
          !current.revokedAt &&
          current.expiresAt > now &&
          this.authTokenService.tokenHashMatches(
            refreshToken,
            current.refreshTokenHash,
          );

        if (!isValid) {
          return { rotated: false as const };
        }

        const consumed = await tx.authSession.updateMany({
          where: {
            id: current.id,
            revokedAt: null,
            expiresAt: { gt: now },
            refreshTokenHash: current.refreshTokenHash,
          },
          data: {
            revokedAt: now,
            lastUsedAt: now,
            revokeReason: SESSION_REVOKE_REASONS.REFRESH_ROTATED,
          },
        });

        if (consumed.count !== 1) {
          return { rotated: false as const };
        }

        await tx.authSession.create({
          data: {
            id: nextSessionId,
            familyId: payload.familyId,
            employeeId: payload.sub,
            refreshTokenHash: this.authTokenService.hashToken(
              nextTokens.refreshToken,
            ),
            expiresAt: this.getRefreshExpiry(),
            ...this.normalizeMetadata(metadata),
          },
        });

        return { rotated: true as const };
      },
      { loggerContext: 'AuthSession.refresh' },
    );

    if (!outcome.rotated) {
      await this.revokeFamily(
        payload.sub,
        payload.familyId,
        SESSION_REVOKE_REASONS.REFRESH_REUSE,
      );
      throw new UnauthorizedException(AUTH_ERRORS.INVALID_TOKEN);
    }

    return nextTokens;
  }

  async revoke(refreshToken?: string) {
    if (!refreshToken) return;

    let payload: AuthRefreshTokenPayload;
    try {
      payload = await this.authTokenService.verifyRefreshToken(refreshToken);
    } catch (error) {
      if (error instanceof UnauthorizedException) return;
      throw error;
    }

    // Retry the family-wide revoke if rotation commits after our snapshot.
    await runSerializableTransaction(
      this.prisma,
      async (tx) => {
        const session = await tx.authSession.findUnique({
          where: {
            id: payload.sid,
            employeeId: payload.sub,
            familyId: payload.familyId,
          },
          select: { refreshTokenHash: true },
        });
        if (!session) return;
        await tx.authSession.updateMany({
          where: {
            employeeId: payload.sub,
            familyId: payload.familyId,
            revokedAt: null,
          },
          data: {
            revokedAt: new Date(),
            revokeReason: this.authTokenService.tokenHashMatches(
              refreshToken,
              session.refreshTokenHash,
            )
              ? SESSION_REVOKE_REASONS.LOGOUT
              : SESSION_REVOKE_REASONS.REFRESH_REUSE,
          },
        });
      },
      { loggerContext: 'AuthSession.logout' },
    );
  }

  revokeAllForEmployee(
    employeeId: string,
    reason = SESSION_REVOKE_REASONS.EMPLOYEE_DISABLED,
  ) {
    return this.prisma.authSession.updateMany({
      where: { employeeId, revokedAt: null },
      data: { revokedAt: new Date(), revokeReason: reason },
    });
  }

  private revokeFamily(employeeId: string, familyId: string, reason: string) {
    return runSerializableTransaction(
      this.prisma,
      (tx) =>
        tx.authSession.updateMany({
          where: { employeeId, familyId, revokedAt: null },
          data: { revokedAt: new Date(), revokeReason: reason },
        }),
      { loggerContext: 'AuthSession.reuse' },
    );
  }

  private getRefreshExpiry() {
    return new Date(Date.now() + REFRESH_TOKEN_TTL_MS);
  }

  private normalizeMetadata({ ipAddress, userAgent }: AuthRequestMetadata) {
    return {
      ipAddress: ipAddress?.slice(0, 64),
      userAgent: userAgent?.slice(0, 512),
    };
  }
}

export { SESSION_REVOKE_REASONS };
