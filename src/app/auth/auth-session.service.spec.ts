import { UnauthorizedException } from '@nestjs/common';
import type { ExtendedPrismaClient } from '../../common/prisma/prisma.service';
import { AuthSessionService } from './auth-session.service';
import { AuthTokenService } from './auth-token.service';

describe('AuthSessionService', () => {
  const payload = {
    sub: 'employee-1',
    email: 'owner@example.com',
    sid: 'session-1',
    familyId: 'family-1',
    tokenType: 'refresh' as const,
  };
  const nextTokens = {
    accessToken: 'next-access-token',
    refreshToken: 'next-refresh-token',
  };

  const createFixture = () => {
    const tx = {
      authSession: {
        findUnique: jest.fn(),
        updateMany: jest.fn(),
        create: jest.fn(),
      },
    };
    const prisma = {
      authSession: {
        create: jest.fn(),
        findUnique: jest.fn(),
        updateMany: jest.fn(),
      },
      $transaction: jest.fn(
        (callback: (client: typeof tx) => Promise<unknown>) => callback(tx),
      ),
    };
    const tokenService = {
      verifyRefreshToken: jest.fn().mockResolvedValue(payload),
      createTokenPair: jest.fn().mockResolvedValue(nextTokens),
      hashToken: jest.fn((token: string) => `hash:${token}`),
      tokenHashMatches: jest.fn().mockReturnValue(true),
    };
    const service = new AuthSessionService(
      prisma as unknown as ExtendedPrismaClient,
      tokenService as unknown as AuthTokenService,
    );

    return { prisma, service, tokenService, tx };
  };

  it('stores only the refresh token hash when creating a session', async () => {
    const { prisma, service } = createFixture();

    await service.createSession(
      { id: payload.sub, email: payload.email },
      { ipAddress: '127.0.0.1', userAgent: 'jest' },
    );

    expect(prisma.authSession.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        employeeId: payload.sub,
        refreshTokenHash: 'hash:next-refresh-token',
      }),
    });
    expect(prisma.authSession.create.mock.calls[0][0].data).not.toHaveProperty(
      'refreshToken',
    );
  });

  it('rotates a valid refresh token in a serializable transaction', async () => {
    const { service, tx } = createFixture();
    tx.authSession.findUnique.mockResolvedValue({
      id: payload.sid,
      employeeId: payload.sub,
      familyId: payload.familyId,
      refreshTokenHash: 'hash:current-refresh-token',
      expiresAt: new Date(Date.now() + 60_000),
      revokedAt: null,
      employee: {
        id: payload.sub,
        email: payload.email,
        isActive: true,
      },
    });
    tx.authSession.updateMany.mockResolvedValue({ count: 1 });

    await expect(service.rotate('current-refresh-token', {})).resolves.toEqual(
      nextTokens,
    );
    expect(tx.authSession.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ revokeReason: 'REFRESH_ROTATED' }),
      }),
    );
    expect(tx.authSession.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        familyId: payload.familyId,
        refreshTokenHash: 'hash:next-refresh-token',
      }),
    });
  });

  it('revokes the token family when a refresh token is reused', async () => {
    const { prisma, service, tx } = createFixture();
    tx.authSession.findUnique.mockResolvedValue({
      id: payload.sid,
      employeeId: payload.sub,
      familyId: payload.familyId,
      refreshTokenHash: 'hash:current-refresh-token',
      expiresAt: new Date(Date.now() + 60_000),
      revokedAt: new Date(),
      employee: {
        id: payload.sub,
        email: payload.email,
        isActive: true,
      },
    });

    await expect(service.rotate('current-refresh-token', {})).rejects.toThrow(
      UnauthorizedException,
    );
    expect(prisma.authSession.updateMany).toHaveBeenCalledWith({
      where: {
        employeeId: payload.sub,
        familyId: payload.familyId,
        revokedAt: null,
      },
      data: expect.objectContaining({ revokeReason: 'REFRESH_REUSE' }),
    });
  });

  it('fails closed on a concurrent refresh transaction conflict', async () => {
    const { prisma, service } = createFixture();
    prisma.$transaction.mockRejectedValue({ code: 'P2034' });

    await expect(service.rotate('current-refresh-token', {})).rejects.toThrow(
      UnauthorizedException,
    );
    expect(prisma.authSession.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ revokeReason: 'REFRESH_REUSE' }),
      }),
    );
  });
});
