import { UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { ExtendedPrismaClient } from '../../common/prisma/prisma.service';
import { MailUtilService } from '../../common/utils/mail-util/mail-util.service';
import { StringUtilService } from '../../common/utils/string-util/string-util.service';
import { AuthTokenService } from './auth-token.service';
import { PasswordResetService } from './password-reset.service';

describe('PasswordResetService', () => {
  const createFixture = () => {
    const tx = {
      passwordResetToken: {
        updateMany: jest.fn(),
        create: jest.fn(),
        findUnique: jest.fn(),
      },
      employee: { update: jest.fn() },
      authSession: { updateMany: jest.fn() },
    };
    const prisma = {
      employee: { findFirst: jest.fn() },
      $transaction: jest.fn(
        (callback: (client: typeof tx) => Promise<unknown>) => callback(tx),
      ),
    };
    const config = {
      getOrThrow: jest
        .fn()
        .mockReturnValue('https://coffee.example.com/reset-password'),
    };
    const stringUtil = { hash: jest.fn().mockResolvedValue('password-hash') };
    const mail = { sendMail: jest.fn().mockResolvedValue(undefined) };
    const tokenService = {
      hashToken: jest.fn((token: string) => `hash:${token}`),
    };
    const service = new PasswordResetService(
      prisma as unknown as ExtendedPrismaClient,
      config as unknown as ConfigService,
      stringUtil as unknown as StringUtilService,
      mail as unknown as MailUtilService,
      tokenService as unknown as AuthTokenService,
    );

    return { mail, prisma, service, stringUtil, tokenService, tx };
  };

  it('returns the same response without creating a token for an unknown account', async () => {
    const { mail, prisma, service } = createFixture();
    prisma.employee.findFirst.mockResolvedValue(null);

    await expect(
      service.requestReset({ email: 'missing@example.com' }),
    ).resolves.toEqual({
      message: 'If the account exists, a password reset email has been sent.',
    });
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(mail.sendMail).not.toHaveBeenCalled();
  });

  it('stores a hashed one-time token and uses the configured reset URL', async () => {
    const { mail, prisma, service, tx } = createFixture();
    prisma.employee.findFirst.mockResolvedValue({
      id: 'employee-1',
      email: 'owner@example.com',
    });

    await service.requestReset({ email: 'owner@example.com' });

    expect(tx.passwordResetToken.updateMany).toHaveBeenCalledWith({
      where: { employeeId: 'employee-1', usedAt: null },
      data: { usedAt: expect.any(Date) },
    });
    const createData = tx.passwordResetToken.create.mock.calls[0][0].data;
    expect(createData.tokenHash).toMatch(/^hash:/);
    expect(createData).not.toHaveProperty('token');
    expect(mail.sendMail).toHaveBeenCalledWith(
      expect.objectContaining({
        to: 'owner@example.com',
        context: {
          resetLink: expect.stringMatching(
            /^https:\/\/coffee\.example\.com\/reset-password\?token=/,
          ),
        },
      }),
    );
  });

  it('consumes a reset token and revokes all active sessions atomically', async () => {
    const { service, stringUtil, tx } = createFixture();
    tx.passwordResetToken.findUnique.mockResolvedValue({
      id: 'reset-1',
      employeeId: 'employee-1',
      usedAt: null,
      expiresAt: new Date(Date.now() + 60_000),
      employee: { id: 'employee-1', isActive: true },
    });
    tx.passwordResetToken.updateMany.mockResolvedValue({ count: 1 });

    await expect(
      service.resetPassword({ token: 'raw-token', password: 'new-password' }),
    ).resolves.toEqual({ message: 'Password reset successfully.' });
    expect(stringUtil.hash).toHaveBeenCalledWith('new-password');
    expect(tx.employee.update).toHaveBeenCalledWith({
      where: { id: 'employee-1' },
      data: { password: 'password-hash' },
    });
    expect(tx.authSession.updateMany).toHaveBeenCalledWith({
      where: { employeeId: 'employee-1', revokedAt: null },
      data: expect.objectContaining({ revokeReason: 'PASSWORD_RESET' }),
    });
  });

  it('rejects a reset token that lost a concurrent consume race', async () => {
    const { service, tx } = createFixture();
    tx.passwordResetToken.findUnique.mockResolvedValue({
      id: 'reset-1',
      employeeId: 'employee-1',
      usedAt: null,
      expiresAt: new Date(Date.now() + 60_000),
      employee: { id: 'employee-1', isActive: true },
    });
    tx.passwordResetToken.updateMany.mockResolvedValue({ count: 0 });

    await expect(
      service.resetPassword({ token: 'raw-token', password: 'new-password' }),
    ).rejects.toThrow(UnauthorizedException);
    expect(tx.employee.update).not.toHaveBeenCalled();
    expect(tx.authSession.updateMany).not.toHaveBeenCalled();
  });
});
