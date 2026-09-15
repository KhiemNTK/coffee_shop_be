import { randomUUID } from 'node:crypto';
import { Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { AUTH_ERRORS } from '../../common/consts/message';
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
  ) {
    const sessionId = randomUUID();
    const familyId = randomUUID();
    const tokens = await this.authTokenService.createTokenPair({
      employeeId: employee.id,
      email: employee.email,
      sessionId,
      familyId,
    });

    await this.prisma.authSession.create({
      data: {
        id: sessionId,
        familyId,
        employeeId: employee.id,
        refreshTokenHash: this.authTokenService.hashToken(tokens.refreshToken),
        expiresAt: this.getRefreshExpiry(),
        ...this.normalizeMetadata(metadata),
      },
    });

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
    const now = new Date();

    let outcome: { rotated: boolean };
    try {
      outcome = await this.prisma.$transaction(
        async (tx) => {
          const current = await tx.authSession.findUnique({
            where: { id: payload.sid },
            include: {
              employee: {
                select: { id: true, email: true, isActive: true },
              },
            },
          });

          const isValid =
            current?.employeeId === payload.sub &&
            current.familyId === payload.familyId &&
            current.employee.isActive &&
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
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      );
    } catch (error) {
      if (!this.isTransactionConflict(error)) throw error;
      outcome = { rotated: false };
    }

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

    const session = await this.prisma.authSession.findUnique({
      where: { id: payload.sid },
      select: { id: true, refreshTokenHash: true, familyId: true },
    });
    if (!session) return;

    if (
      !this.authTokenService.tokenHashMatches(
        refreshToken,
        session.refreshTokenHash,
      )
    ) {
      await this.revokeFamily(
        payload.sub,
        payload.familyId,
        SESSION_REVOKE_REASONS.REFRESH_REUSE,
      );
      return;
    }

    await this.prisma.authSession.updateMany({
      where: { id: session.id, employeeId: payload.sub, revokedAt: null },
      data: {
        revokedAt: new Date(),
        revokeReason: SESSION_REVOKE_REASONS.LOGOUT,
      },
    });
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
    return this.prisma.authSession.updateMany({
      where: { employeeId, familyId, revokedAt: null },
      data: { revokedAt: new Date(), revokeReason: reason },
    });
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

  private isTransactionConflict(error: unknown) {
    return (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      error.code === 'P2034'
    );
  }
}

export { SESSION_REVOKE_REASONS };
