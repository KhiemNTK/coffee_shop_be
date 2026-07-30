import {
  Injectable,
  CanActivate,
  ExecutionContext,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { Request } from 'express';
import { AUTH_ERRORS } from '../../common/consts/message';

@Injectable()
export class ResetPasswordGuard implements CanActivate {
  constructor(
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request>();

    const token = request.body?.token;

    if (!token || typeof token !== 'string') {
      throw new UnauthorizedException(AUTH_ERRORS.INVALID_TOKEN);
    }

    try {
      const resetSecret =
        this.configService.get<string>('JWT_RESET_SECRET') ||
        AUTH_ERRORS.INVALID_SECRET_KEY;

      const payload = await this.jwtService.verifyAsync(token, {
        secret: resetSecret,
      });

      request['employee'] = {
        employeeId: payload.sub,
      };

      return true;
    } catch (err) {
      throw new UnauthorizedException(AUTH_ERRORS.INVALID_TOKEN);
    }
  }
}
