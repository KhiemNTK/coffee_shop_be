import { randomBytes } from 'node:crypto';
import {
  Inject,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AUTH_ERRORS } from '../../common/consts/message';
import {
  PRISMA_SERVICE_TOKEN,
  type ExtendedPrismaClient,
} from '../../common/prisma/prisma.service';
import { StringUtilService } from '../../common/utils/string-util/string-util.service';
import { MailTemplate } from '../../common/utils/mail-util/mail-util.const';
import { MailUtilService } from '../../common/utils/mail-util/mail-util.service';
import { ForgotPasswordDto, ResetPasswordDto } from './dto/password.dto';
import { JWTToken } from './consts/jwt.const';
import { AuthTokenService } from './auth-token.service';
import { SESSION_REVOKE_REASONS } from './auth-session.service';

@Injectable()
export class PasswordResetService {
  private readonly logger = new Logger(PasswordResetService.name);
  private readonly genericResponse = {
    message: 'If the account exists, a password reset email has been sent.',
  };

  constructor(
    @Inject(PRISMA_SERVICE_TOKEN)
    private readonly prisma: ExtendedPrismaClient,
    private readonly configService: ConfigService,
    private readonly stringUtilService: StringUtilService,
    private readonly mailUtilService: MailUtilService,
    private readonly authTokenService: AuthTokenService,
  ) {}

  async requestReset({ email, phoneNumber }: ForgotPasswordDto) {
    const employee = await this.prisma.employee.findFirst({
      where: {
        isActive: true,
        OR: [
          ...(email ? [{ email }] : []),
          ...(phoneNumber ? [{ phoneNumber }] : []),
        ],
      },
      select: { id: true, email: true },
    });
    if (!employee) return this.genericResponse;

    const rawToken = randomBytes(32).toString('base64url');
    const now = new Date();
    await this.prisma.$transaction(async (tx) => {
      await tx.passwordResetToken.updateMany({
        where: { employeeId: employee.id, usedAt: null },
        data: { usedAt: now },
      });
      await tx.passwordResetToken.create({
        data: {
          employeeId: employee.id,
          tokenHash: this.authTokenService.hashToken(rawToken),
          expiresAt: new Date(
            now.getTime() +
              JWTToken.PASSWORD_RESET_EXPIRE_IN_MINUTES * 60 * 1000,
          ),
        },
      });
    });

    const resetUrl = new URL(
      this.configService.getOrThrow<string>('PASSWORD_RESET_URL'),
    );
    resetUrl.searchParams.set('token', rawToken);
    void this.mailUtilService
      .sendMail({
        to: employee.email,
        subject: '[Coffee Shop] Reset your password',
        template: MailTemplate.RESET_PASSWORD,
        context: { resetLink: resetUrl.toString() },
      })
      .catch((error: unknown) => {
        this.logger.error(
          'Password reset email dispatch failed',
          error instanceof Error ? error.stack : String(error),
        );
      });

    return this.genericResponse;
  }

  async resetPassword({ token, password }: ResetPasswordDto) {
    const tokenHash = this.authTokenService.hashToken(token);
    const passwordHash = await this.stringUtilService.hash(password);
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
