import {
  BadRequestException,
  Injectable,
  UnauthorizedException,
  Logger,
  InternalServerErrorException,
  Inject,
} from '@nestjs/common';
import { EmployeesService } from '../employees/employees.service';
import { StringUtilService } from '../../common/utils/string-util/string-util.service';
import { JwtService } from '@nestjs/jwt';
import { SignInDto, SignUpDto } from './dto/sign.dto';
import { JWTToken, TokenKeys } from './consts/jwt.const';
import { ForgotPasswordDto } from './dto/password.dto';
import type { ExtendedPrismaClient } from '../../common/prisma/prisma.service';
import { PRISMA_SERVICE_TOKEN } from '../../common/prisma/prisma.service';
import { MailUtilService } from '../../common/utils/mail-util/mail-util.service';
import { MailTemplate } from '../../common/utils/mail-util/mail-util.const';
import { ConfigService } from '@nestjs/config';
import { AUTH_ERRORS, SYSTEM_ERRORS } from '../../common/consts/message';
import { AuthorizationService } from '../authorization/authorization.service';
import { DEFAULT_EMPLOYEE_ROLE_NAME } from '../../common/consts/permission-keys';
import type { EmployeeInfo } from '../../common/types';
@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    @Inject(PRISMA_SERVICE_TOKEN)
    private readonly prisma: ExtendedPrismaClient,
    private readonly employeesService: EmployeesService,
    private readonly stringUtilService: StringUtilService,
    private readonly jwtService: JwtService,
    private readonly mailUtilService: MailUtilService,
    private readonly configService: ConfigService,
    private readonly authorizationService: AuthorizationService,
  ) {}

  async createToken<T extends Record<string, any>>(payload: T) {
    const accessToken = await this.jwtService.signAsync(payload, {
      expiresIn: JWTToken.ACCESS_TOKEN_EXPIRE_IN,
    });
    const refreshToken = await this.jwtService.signAsync(payload, {
      expiresIn: JWTToken.REFRESH_TOKEN_EXPIRE_IN,
    });
    return {
      [TokenKeys.ACCESS_TOKEN_KEY]: accessToken,
      [TokenKeys.REFRESH_TOKEN_KEY]: refreshToken,
    };
  }

  async verifyToken(token: string) {
    try {
      const decoded = await this.jwtService.verifyAsync(token);
      return decoded;
    } catch (error) {
      throw new UnauthorizedException(AUTH_ERRORS.INVALID_TOKEN);
    }
  }

  async getAuthenticatedEmployee(employeeId: string): Promise<EmployeeInfo> {
    const employee = await this.prisma.employee.findUnique({
      where: { id: employeeId },
      select: { id: true, email: true, isActive: true },
    });

    if (!employee || !employee.isActive) {
      throw new UnauthorizedException(AUTH_ERRORS.INACTIVE_EMPLOYEE);
    }

    return {
      employeeId: employee.id,
      employeeEmail: employee.email,
      email: employee.email,
    };
  }

  async signUp(signUpDto: SignUpDto) {
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
    const employeeCreated = await this.prisma.$transaction(async (tx) => {
      const employee = await tx.employee.create({
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
          data: { employeeId: employee.id, roleId: defaultRole.id },
        });
      }

      return employee;
    });
    await this.authorizationService.invalidateEmployee(employeeCreated.id);

    return this.createToken({
      employeeId: employeeCreated.id,
      employeeEmail: employeeCreated.email,
    });
  }

  async signIn(signInDto: SignInDto) {
    const { email, password } = signInDto;
    const employee = await this.employeesService.getEmployee({ email });
    const passwordHashed = employee?.password;
    if (!employee || !passwordHashed || !employee.isActive) {
      throw new UnauthorizedException();
    }
    const isMatch = await this.stringUtilService.compare(
      password,
      passwordHashed,
    );
    if (!isMatch) {
      throw new UnauthorizedException();
    }
    const { id: employeeId, email: employeeEmail } = employee;
    return await this.createToken({
      employeeId,
      employeeEmail,
    });
  }

  async refreshToken(refreshToken: string) {
    const decoded = await this.verifyToken(refreshToken);
    const employeeId = decoded.employeeId as string | undefined;
    if (!employeeId) {
      throw new UnauthorizedException(AUTH_ERRORS.INVALID_TOKEN);
    }
    const employee = await this.getAuthenticatedEmployee(employeeId);
    return this.createToken({
      employeeId: employee.employeeId,
      employeeEmail: employee.employeeEmail,
    });
  }

  async getMe(employeeId: string) {
    await this.getAuthenticatedEmployee(employeeId);

    return this.prisma.employee.findUnique({
      where: { id: employeeId },
      select: {
        id: true,
        email: true,
        username: true,
        fullName: true,
        avatarUrl: true,
        phoneNumber: true,
        isActive: true,
        position: {
          select: { id: true, name: true },
        },
        employeeRoles: {
          select: {
            role: {
              select: { id: true, name: true, description: true },
            },
          },
        },
      },
    });
  }

  async getMyPermissions(employeeId: string) {
    return this.authorizationService.getAuthorizationContext(employeeId);
  }

  async forgotPassword(forgotPasswordDto: ForgotPasswordDto) {
    const { email, phoneNumber, redirectTo } = forgotPasswordDto;
    const employee = await this.prisma.employee.findFirst({
      where: {
        OR: [{ email }, { phoneNumber }],
      },
    });
    if (!employee) {
      return { message: 'Check your email for password reset link' };
    }

    const employeeEmail = employee.email;

    const resetSecret =
      this.configService.get<string>('JWT_RESET_SECRET') ||
      AUTH_ERRORS.INVALID_SECRET_KEY;

    const resetToken = await this.jwtService.signAsync(
      { sub: employee.id },
      { expiresIn: '15m', secret: resetSecret },
    );
    const resetLink = `${redirectTo}?token=${resetToken}`;

    this.mailUtilService
      .sendMail({
        to: employeeEmail,
        subject: '[System] Reset your password',
        template: MailTemplate.RESET_PASSWORD,
        context: {
          resetLink,
        },
      })
      .catch((error) => {
        this.logger.error(
          `[ForgotPassword] Failed to send email to ${employee.email}`,
          error.stack,
        );
      });
    return { message: 'Check your email for password reset link' };
  }

  async resetPassword(employeeId: string, newPassword: string) {
    const hashedPassword = await this.stringUtilService.hash(newPassword);
    await this.prisma.employee.update({
      where: { id: employeeId },
      data: { password: hashedPassword },
    });

    return { message: 'Reset password success!' };
  }
}
