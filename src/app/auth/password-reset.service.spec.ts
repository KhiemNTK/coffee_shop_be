import { UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Prisma } from '@prisma/client';
import type { ExtendedPrismaClient } from '../../common/prisma/prisma.service';
import { MailUtilService } from '../../common/utils/mail-util/mail-util.service';
import { PasswordHashService } from '../../common/utils/password-hash/password-hash.service';
import { AuthTokenService } from './auth-token.service';
import { PasswordResetService } from './password-reset.service';
import { DomainEventBusService } from '../durable/domain-event-bus.service';
import { OutboxService } from '../durable/outbox.service';

describe('PasswordResetService', () => {
  const createFixture = () => {
    const tx = {
      passwordResetToken: {
        updateMany: jest.fn(),
        create: jest.fn<
          Promise<unknown>,
          [Prisma.PasswordResetTokenCreateArgs]
        >(),
        findUnique: jest.fn(),
      },
      employee: { update: jest.fn() },
      authSession: { updateMany: jest.fn() },
    };
    const prisma = {
      employee: { findFirst: jest.fn() },
      passwordResetToken: { findUnique: jest.fn() },
      $transaction: jest.fn(
        (callback: (client: typeof tx) => Promise<unknown>) => callback(tx),
      ),
    };
    const config = {
      getOrThrow: jest
        .fn()
        .mockImplementation((key: string) =>
          key === 'JWT_SECRET'
            ? 'test-only-password-reset-signing-secret'
            : 'https://coffee.example.com/reset-password',
        ),
    };
    const passwordHash = { hash: jest.fn().mockResolvedValue('password-hash') };
    const mail = {
      sendMail: jest
        .fn<Promise<void>, Parameters<MailUtilService['sendMail']>>()
        .mockResolvedValue(undefined),
    };
    const tokenService = new AuthTokenService(
      {} as never,
      config as unknown as ConfigService,
    );
    const outbox = {
      enqueue: jest
        .fn<Promise<{ id: string }>, Parameters<OutboxService['enqueue']>>()
        .mockResolvedValue({ id: 'event-id' }),
    };
    const eventBus = new DomainEventBusService();
    const service = new PasswordResetService(
      prisma as unknown as ExtendedPrismaClient,
      config as unknown as ConfigService,
      passwordHash as unknown as PasswordHashService,
      mail as unknown as MailUtilService,
      tokenService,
      outbox as unknown as OutboxService,
      eventBus,
    );
    service.onModuleInit();

    return {
      mail,
      prisma,
      service,
      passwordHash,
      tokenService,
      tx,
      outbox,
      eventBus,
    };
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

  it('queues only a token ID atomically and derives the link at delivery time', async () => {
    const { mail, prisma, service, tx, outbox, eventBus, tokenService } =
      createFixture();
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
    expect(createData.tokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(createData).not.toHaveProperty('token');
    const event = outbox.enqueue.mock.calls[0][1];
    expect(outbox.enqueue).toHaveBeenCalledWith(tx, {
      topic: 'auth',
      eventName: 'auth.password-reset.email-requested',
      aggregateType: 'PasswordResetToken',
      aggregateId: createData.id,
      payload: { resetTokenId: createData.id },
    });
    expect(mail.sendMail).not.toHaveBeenCalled();
    prisma.passwordResetToken.findUnique.mockResolvedValue({
      ...createData,
      usedAt: null,
      employee: { email: 'owner@example.com', isActive: true, deletedAt: null },
    });
    await eventBus.publish(event.eventName, event.payload);
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
    const raw = new URL(
      String(mail.sendMail.mock.calls[0][0].context.resetLink),
    ).searchParams.get('token')!;
    expect(tokenService.tokenHashMatches(raw, createData.tokenHash)).toBe(true);
    expect(JSON.stringify(event)).not.toContain(raw);
    expect(JSON.stringify(event)).not.toContain('owner@example.com');
  });

  it('can deliver after restart using only the persisted token and outbox event', async () => {
    const first = createFixture();
    first.prisma.employee.findFirst.mockResolvedValue({ id: 'employee-1' });
    await first.service.requestReset({ email: 'owner@example.com' });
    const record = first.tx.passwordResetToken.create.mock.calls[0][0].data;
    const event = first.outbox.enqueue.mock.calls[0][1];
    first.service.onApplicationShutdown();

    const restarted = createFixture();
    restarted.prisma.passwordResetToken.findUnique.mockResolvedValue({
      ...record,
      usedAt: null,
      employee: { email: 'owner@example.com', isActive: true, deletedAt: null },
    });
    await restarted.eventBus.publish(event.eventName, event.payload);
    const raw = new URL(
      String(restarted.mail.sendMail.mock.calls[0][0].context.resetLink),
    ).searchParams.get('token')!;
    expect(first.tokenService.tokenHashMatches(raw, record.tokenHash)).toBe(
      true,
    );
    expect(first.mail.sendMail).not.toHaveBeenCalled();
  });

  it('fails the request when the durable intent cannot be committed', async () => {
    const { prisma, service, outbox, mail } = createFixture();
    prisma.employee.findFirst.mockResolvedValue({ id: 'employee-1' });
    outbox.enqueue.mockRejectedValue(new Error('database unavailable'));
    await expect(
      service.requestReset({ email: 'owner@example.com' }),
    ).rejects.toThrow('database unavailable');
    expect(mail.sendMail).not.toHaveBeenCalled();
  });

  it('propagates a safe delivery failure for outbox retry, then sends the same token', async () => {
    const { prisma, service, mail, tx, outbox, eventBus } = createFixture();
    prisma.employee.findFirst.mockResolvedValue({ id: 'employee-1' });
    await service.requestReset({ email: 'owner@example.com' });
    prisma.passwordResetToken.findUnique.mockResolvedValue({
      ...tx.passwordResetToken.create.mock.calls[0][0].data,
      usedAt: null,
      employee: { email: 'owner@example.com', isActive: true, deletedAt: null },
    });
    const event = outbox.enqueue.mock.calls[0][1];
    mail.sendMail.mockRejectedValueOnce(
      new Error('SMTP credentials or recipient details'),
    );
    await expect(
      eventBus.publish(event.eventName, event.payload),
    ).rejects.toThrow('Password reset email delivery failed.');
    await eventBus.publish(event.eventName, event.payload);
    expect(mail.sendMail).toHaveBeenCalledTimes(2);
    expect(mail.sendMail.mock.calls[0][0]).toEqual(
      mail.sendMail.mock.calls[1][0],
    );
  });

  it.each(['used', 'expired', 'inactive', 'deleted', 'rotated-key', 'missing'])(
    'does not email a %s token',
    async (state) => {
      const { prisma, service, mail, tx, outbox, eventBus } = createFixture();
      prisma.employee.findFirst.mockResolvedValue({ id: 'employee-1' });
      await service.requestReset({ email: 'owner@example.com' });
      const data = tx.passwordResetToken.create.mock.calls[0][0].data;
      prisma.passwordResetToken.findUnique.mockResolvedValue(
        state === 'missing'
          ? null
          : {
              ...data,
              tokenHash:
                state === 'rotated-key' ? '0'.repeat(64) : data.tokenHash,
              usedAt: state === 'used' ? new Date() : null,
              expiresAt: state === 'expired' ? new Date(0) : data.expiresAt,
              employee: {
                email: 'owner@example.com',
                isActive: state !== 'inactive',
                deletedAt: state === 'deleted' ? new Date() : null,
              },
            },
      );
      const event = outbox.enqueue.mock.calls[0][1];
      await eventBus.publish(event.eventName, event.payload);
      expect(mail.sendMail).not.toHaveBeenCalled();
    },
  );

  it('consumes a reset token and revokes all active sessions atomically', async () => {
    const { service, passwordHash, tx } = createFixture();
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
    expect(passwordHash.hash).toHaveBeenCalledWith('new-password');
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
