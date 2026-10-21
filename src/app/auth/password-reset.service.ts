import { createHmac, randomUUID } from 'node:crypto';
import {
  Inject,
  Injectable,
  OnApplicationShutdown,
  OnModuleInit,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AUTH_ERRORS } from '../../common/consts/message';
import {
  PRISMA_SERVICE_TOKEN,
  type ExtendedPrismaClient,
} from '../../common/prisma/prisma.service';
import { PasswordHashService } from '../../common/utils/password-hash/password-hash.service';
import { MailTemplate } from '../../common/utils/mail-util/mail-util.const';
import { MailUtilService } from '../../common/utils/mail-util/mail-util.service';
import { ForgotPasswordDto, ResetPasswordDto } from './dto/password.dto';
import { JWTToken } from './consts/jwt.const';
import { AuthTokenService } from './auth-token.service';
import { SESSION_REVOKE_REASONS } from './auth-session.service';
import { DomainEventBusService } from '../durable/domain-event-bus.service';
import { OutboxService } from '../durable/outbox.service';
import { runSerializableTransaction } from '../../common/prisma/transaction.util';
import { z } from 'zod';

const RESET_EMAIL_REQUESTED = 'auth.password-reset.email-requested';
const ResetEmailSchema = z.object({ resetTokenId: z.uuid() });

@Injectable()
export class PasswordResetService
  implements OnModuleInit, OnApplicationShutdown
{
  private unsubscribe?: () => void;
  private readonly genericResponse = {
    message: 'If the account exists, a password reset email has been sent.',
  };

  constructor(
    @Inject(PRISMA_SERVICE_TOKEN)
    private readonly prisma: ExtendedPrismaClient,
    private readonly configService: ConfigService,
    private readonly passwordHashService: PasswordHashService,
    private readonly mailUtilService: MailUtilService,
    private readonly authTokenService: AuthTokenService,
    private readonly outbox: OutboxService,
    private readonly eventBus: DomainEventBusService,
  ) {}

  onModuleInit() {
    this.unsubscribe = this.eventBus.on(RESET_EMAIL_REQUESTED, (payload) =>
      this.sendResetEmail(payload),
    );
  }

  onApplicationShutdown() {
    this.unsubscribe?.();
  }

  async requestReset({ email, phoneNumber }: ForgotPasswordDto) {
    const employee = await this.prisma.employee.findFirst({
      where: {
        isActive: true,
        OR: [
          ...(email ? [{ email }] : []),
          ...(phoneNumber ? [{ phoneNumber }] : []),
        ],
      },
      select: { id: true },
    });
    if (!employee) return this.genericResponse;

    const resetTokenId = randomUUID();
    const rawToken = this.resetToken(resetTokenId);
    const now = new Date();
    await runSerializableTransaction(this.prisma, async (tx) => {
      await tx.passwordResetToken.updateMany({
        where: { employeeId: employee.id, usedAt: null },
        data: { usedAt: now },
      });
      await tx.passwordResetToken.create({
        data: {
          id: resetTokenId,
          employeeId: employee.id,
          tokenHash: this.authTokenService.hashToken(rawToken),
          expiresAt: new Date(
            now.getTime() +
              JWTToken.PASSWORD_RESET_EXPIRE_IN_MINUTES * 60 * 1000,
          ),
        },
      });
      await this.outbox.enqueue(tx, {
        topic: 'auth',
        eventName: RESET_EMAIL_REQUESTED,
        aggregateType: 'PasswordResetToken',
        aggregateId: resetTokenId,
        payload: { resetTokenId },
      });
    });

    return this.genericResponse;
  }

  private async sendResetEmail(payload: unknown) {
    const { resetTokenId } = ResetEmailSchema.parse(payload);
    const token = await this.prisma.passwordResetToken.findUnique({
      where: { id: resetTokenId },
      select: {
        tokenHash: true,
        usedAt: true,
        expiresAt: true,
        employee: { select: { email: true, isActive: true, deletedAt: true } },
      },
    });
    if (
      !token ||
      token.usedAt ||
      token.expiresAt <= new Date() ||
      !token.employee.isActive ||
      token.employee.deletedAt
    )
      return;
    const rawToken = this.resetToken(resetTokenId);
    // A key rotation makes queued links obsolete; never send a different token.
    if (!this.authTokenService.tokenHashMatches(rawToken, token.tokenHash))
      return;
    const resetUrl = new URL(
      this.configService.getOrThrow<string>('PASSWORD_RESET_URL'),
    );
    resetUrl.searchParams.set('token', rawToken);
    try {
      await this.mailUtilService.sendMail({
        to: token.employee.email,
        subject: '[Coffee Shop] Reset your password',
        template: MailTemplate.RESET_PASSWORD,
        context: { resetLink: resetUrl.toString() },
      });
    } catch {
      throw new Error('Password reset email delivery failed.');
    }
  }

  private resetToken(id: string) {
    // Derive on delivery so neither the outbox nor Redis stores a bearer secret.
    return createHmac(
      'sha256',
      this.configService.getOrThrow<string>('JWT_SECRET'),
    )
      .update(`password-reset:v1:${id}`)
      .digest('base64url');
  }

  async resetPassword({ token, password }: ResetPasswordDto) {
    const tokenHash = this.authTokenService.hashToken(token);
    const passwordHash = await this.passwordHashService.hash(password);
    const now = new Date();

    const reset = await this.prisma.$transaction(async (tx) => {
      const record = await tx.passwordResetToken.findUnique({
        where: { tokenHash },
        include: { employee: { select: { id: true, isActive: true } } },
      });
      if (
        !record ||
        record.usedAt ||
        record.expiresAt <= now ||
        !record.employee.isActive
      ) {
        return false;
      }

      const consumed = await tx.passwordResetToken.updateMany({
        where: { id: record.id, usedAt: null, expiresAt: { gt: now } },
        data: { usedAt: now },
      });
      if (consumed.count !== 1) return false;

      await tx.employee.update({
        where: { id: record.employeeId },
        data: { password: passwordHash },
      });
      await tx.authSession.updateMany({
        where: { employeeId: record.employeeId, revokedAt: null },
        data: {
          revokedAt: now,
          revokeReason: SESSION_REVOKE_REASONS.PASSWORD_RESET,
        },
      });
      return true;
    });

    if (!reset) {
      throw new UnauthorizedException(AUTH_ERRORS.INVALID_TOKEN);
    }

    return { message: 'Password reset successfully.' };
  }
}
