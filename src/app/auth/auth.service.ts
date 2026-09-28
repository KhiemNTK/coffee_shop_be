import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  InternalServerErrorException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import { AUTH_ERRORS, SYSTEM_ERRORS } from '../../common/consts/message';
import { DEFAULT_EMPLOYEE_ROLE_NAME } from '../../common/consts/permission-keys';
import {
  PRISMA_SERVICE_TOKEN,
  type ExtendedPrismaClient,
} from '../../common/prisma/prisma.service';
import type { AuthRequestMetadata, EmployeeInfo } from '../../common/types';
import { StringUtilService } from '../../common/utils/string-util/string-util.service';
import { AuthorizationService } from '../authorization/authorization.service';
import { EmployeesService } from '../employees/employees.service';
import {
  AuthSessionService,
  SESSION_REVOKE_REASONS,
} from './auth-session.service';
import { AuthTokenService } from './auth-token.service';
import {
  ForgotPasswordDto,
  GoogleLinkDto,
  GoogleSignInDto,
  GoogleUnlinkDto,
  ResetPasswordDto,
  SignInDto,
  SignUpDto,
} from './dto';
import { PasswordResetService } from './password-reset.service';
import { GoogleIdentityService } from './google-identity.service';
import { TurnstileService } from './turnstile.service';

@Injectable()
export class AuthService {
  constructor(
    @Inject(PRISMA_SERVICE_TOKEN)
    private readonly prisma: ExtendedPrismaClient,
    private readonly employeesService: EmployeesService,
    private readonly stringUtilService: StringUtilService,
    private readonly configService: ConfigService,
    private readonly authorizationService: AuthorizationService,
    private readonly authTokenService: AuthTokenService,
    private readonly authSessionService: AuthSessionService,
    private readonly passwordResetService: PasswordResetService,
    private readonly googleIdentity: GoogleIdentityService,
    private readonly turnstile: TurnstileService,
  ) {}

  verifyAccessToken(token: string) {
    return this.authTokenService.verifyAccessToken(token);
  }

  async getAuthenticatedEmployee(
    employeeId: string,
    sessionId: string,
  ): Promise<EmployeeInfo> {
    const employee = await this.prisma.employee.findFirst({
      where: {
        id: employeeId,
        isActive: true,
        authSessions: {
          some: {
            id: sessionId,
            revokedAt: null,
            expiresAt: { gt: new Date() },
          },
        },
      },
      select: { id: true, email: true },
    });

    if (!employee) {
      throw new UnauthorizedException(AUTH_ERRORS.INACTIVE_EMPLOYEE);
    }

    return {
      employeeId: employee.id,
      employeeEmail: employee.email,
      email: employee.email,
      sessionId,
    };
  }

  async signUp(signUpDto: SignUpDto, metadata: AuthRequestMetadata) {
    this.assertSignUpEnabled();
    const { email, password, username, fullName, address, phoneNumber } =
      signUpDto;
    const existingEmail = await this.employeesService.getEmployee({ email });
    if (existingEmail) {
      throw new BadRequestException(AUTH_ERRORS.EMAIL_ALREADY_EXISTS);
    }

    const existingUsername = await this.prisma.employee.findUnique({
      where: { username },
    });
    if (existingUsername) {
      throw new BadRequestException(AUTH_ERRORS.USERNAME_ALREADY_EXISTS);
    }

    const defaultPosition = await this.prisma.position.findFirst({
      where: { name: 'Staff' },
    });
    if (!defaultPosition) {
      throw new InternalServerErrorException(
        SYSTEM_ERRORS.INVALID_DEFAULT_POSITION,
      );
    }

    const passwordHashed = await this.stringUtilService.hash(password);
    const employee = await this.prisma.$transaction(async (tx) => {
      const created = await tx.employee.create({
        data: {
          email,
          username,
          password: passwordHashed,
          positionId: defaultPosition.id,
          fullName,
          address,
          phoneNumber,
          isActive: true,
        },
      });
      const defaultRole = await tx.role.findFirst({
        where: { name: DEFAULT_EMPLOYEE_ROLE_NAME },
        select: { id: true },
      });
      if (defaultRole) {
        await tx.employeeRole.create({
          data: { employeeId: created.id, roleId: defaultRole.id },
        });
      }
      return created;
    });
    await this.authorizationService.invalidateEmployee(employee.id);
    return this.authSessionService.createSession(employee, metadata);
  }

  async signIn(signInDto: SignInDto, metadata: AuthRequestMetadata) {
    await this.turnstile.verify(signInDto.turnstileToken, metadata.ipAddress);
    const employee = await this.employeesService.getEmployee({
      email: signInDto.email,
    });
    if (!employee?.password || !employee.isActive) {
      throw new UnauthorizedException(AUTH_ERRORS.INVALID_CREDENTIALS);
    }
    const passwordMatches = await this.stringUtilService.compare(
      signInDto.password,
      employee.password,
    );
    if (!passwordMatches) {
      throw new UnauthorizedException(AUTH_ERRORS.INVALID_CREDENTIALS);
    }
    return this.authSessionService.createSession(employee, metadata);
  }

  async signInWithGoogle(dto: GoogleSignInDto, metadata: AuthRequestMetadata) {
    await this.turnstile.verify(dto.turnstileToken, metadata.ipAddress);
    const identity = await this.googleIdentity.verify(dto.idToken);
    const employee = await this.prisma.employee.findFirst({
      where: { googleSubject: identity.subject, isActive: true },
      select: { id: true, email: true },
    });
    if (!employee) {
      throw new UnauthorizedException(AUTH_ERRORS.INVALID_CREDENTIALS);
    }
    return this.authSessionService.createSession(
      employee,
      metadata,
      identity.subject,
    );
  }

  async linkGoogle(employeeId: string, dto: GoogleLinkDto) {
    const employee = await this.prisma.employee.findUnique({
      where: { id: employeeId },
      select: {
        id: true,
        email: true,
        password: true,
        isActive: true,
        googleSubject: true,
      },
    });
    if (
      !employee?.isActive ||
      !(await this.stringUtilService.compare(dto.password, employee.password))
    ) {
      throw new UnauthorizedException(AUTH_ERRORS.INVALID_CREDENTIALS);
    }
    const identity = await this.googleIdentity.verify(dto.idToken);
    if (identity.email.toLowerCase() !== employee.email.toLowerCase()) {
      throw new BadRequestException('Google email must match employee email.');
    }
    if (employee.googleSubject === identity.subject) return { linked: true };
    if (employee.googleSubject) {
      throw new BadRequestException('A Google account is already linked.');
    }

    try {
      await this.prisma.$transaction(async (tx) => {
        const updated = await tx.employee.updateMany({
          where: {
            id: employeeId,
            googleSubject: null,
            isActive: true,
            deletedAt: null,
            email: employee.email,
            password: employee.password,
          },
          data: { googleSubject: identity.subject },
        });
        if (updated.count !== 1) {
          throw new BadRequestException('Google account link changed.');
        }
        await tx.actionLog.create({
          data: {
            employeeId,
            actionType: 'GOOGLE_ACCOUNT_LINKED',
            details: { provider: 'GOOGLE' },
          },
        });
      });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        throw new BadRequestException('Google account is already linked.');
      }
      throw error;
    }
    return { linked: true };
  }

  async unlinkGoogle(employeeId: string, dto: GoogleUnlinkDto) {
    const employee = await this.prisma.employee.findUnique({
      where: { id: employeeId },
      select: { password: true, isActive: true, googleSubject: true },
    });
    if (
      !employee?.isActive ||
      !(await this.stringUtilService.compare(dto.password, employee.password))
    ) {
      throw new UnauthorizedException(AUTH_ERRORS.INVALID_CREDENTIALS);
    }
    if (!employee.googleSubject) return { unlinked: true };

    await this.prisma.$transaction(async (tx) => {
      const updated = await tx.employee.updateMany({
        where: {
          id: employeeId,
          googleSubject: employee.googleSubject,
          isActive: true,
          deletedAt: null,
          password: employee.password,
        },
        data: { googleSubject: null },
      });
      if (updated.count !== 1) {
        throw new BadRequestException('Google account link changed.');
      }
      await tx.authSession.updateMany({
        where: { employeeId, revokedAt: null },
        data: {
          revokedAt: new Date(),
          revokeReason: SESSION_REVOKE_REASONS.GOOGLE_UNLINKED,
        },
      });
      await tx.actionLog.create({
        data: {
          employeeId,
          actionType: 'GOOGLE_ACCOUNT_UNLINKED',
          details: { provider: 'GOOGLE' },
        },
      });
    });
    return { unlinked: true };
  }

  refreshToken(refreshToken: string, metadata: AuthRequestMetadata) {
    if (!refreshToken) {
      throw new UnauthorizedException(AUTH_ERRORS.INVALID_TOKEN);
    }
    return this.authSessionService.rotate(refreshToken, metadata);
  }

  logout(refreshToken?: string) {
    return this.authSessionService.revoke(refreshToken);
  }

  async getMe(employeeId: string) {
    const employee = await this.prisma.employee.findUnique({
      where: { id: employeeId },
      select: {
        id: true,
        email: true,
        username: true,
        fullName: true,
        avatarUrl: true,
        phoneNumber: true,
        isActive: true,
        googleSubject: true,
        position: { select: { id: true, name: true } },
        employeeRoles: {
          where: { role: { deletedAt: null } },
          select: {
            role: {
              select: { id: true, name: true, description: true },
            },
          },
        },
      },
    });
    if (!employee) return null;
    const { googleSubject, ...profile } = employee;
    return { ...profile, googleLinked: Boolean(googleSubject) };
  }

  getMyPermissions(employeeId: string) {
    return this.authorizationService.getAuthorizationContext(employeeId);
  }

  async forgotPassword(dto: ForgotPasswordDto, metadata: AuthRequestMetadata) {
    await this.turnstile.verify(
      dto.turnstileToken,
      metadata.ipAddress,
      'password_reset',
    );
    return this.passwordResetService.requestReset(dto);
  }

  resetPassword(dto: ResetPasswordDto) {
    return this.passwordResetService.resetPassword(dto);
  }

  private assertSignUpEnabled() {
    const enabled = this.configService.get<boolean>(
      'AUTH_SIGNUP_ENABLED',
      false,
    );
    if (!enabled || this.configService.get('NODE_ENV') === 'production') {
      throw new ForbiddenException(AUTH_ERRORS.SIGN_UP_DISABLED);
    }
  }
}
