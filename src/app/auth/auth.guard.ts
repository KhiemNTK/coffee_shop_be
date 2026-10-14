import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { AuthenticatedStaffRequest } from '../../common/types';
import { AUTH_ERRORS } from '../../common/consts/message';
import { setRequestEmployee } from '../../common/request-context';
import { TokenKeys } from './consts/jwt.const';
import { IS_SKIP_AUTH } from './auth.decorator';
import { AuthService } from './auth.service';

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly authService: AuthService,
  ) {}

  async canActivate(context: ExecutionContext) {
    const skipAuth = this.reflector.getAllAndOverride<boolean>(IS_SKIP_AUTH, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (skipAuth) return true;

    const req = context.switchToHttp().getRequest<AuthenticatedStaffRequest>();
    const credential = this.extractToken(req);
    if (!credential) {
      throw new UnauthorizedException(AUTH_ERRORS.INVALID_TOKEN);
    }

    const payload = await this.authService.verifyAccessToken(credential.token);
    req.employee = await this.authService.getAuthenticatedEmployee(
      payload.sub,
      payload.sid,
    );
    req.authMethod = credential.method;
    setRequestEmployee(payload.sub);
    return true;
  }

  private extractToken(req: AuthenticatedStaffRequest) {
    const authorization = req.headers.authorization;
    if (authorization !== undefined) {
      const match = /^Bearer ([^\s]+)$/i.exec(authorization);
      return match ? { token: match[1], method: 'bearer' as const } : undefined;
    }
    const token: unknown = req.cookies?.[TokenKeys.ACCESS_TOKEN_KEY];
    return typeof token === 'string' && token
      ? { token, method: 'cookie' as const }
      : undefined;
  }
}
