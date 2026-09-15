import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { AUTH_ERRORS } from '../../common/consts/message';
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

    const req = context.switchToHttp().getRequest<Request>();
    const token = this.extractToken(req);
    if (!token) {
      throw new UnauthorizedException(AUTH_ERRORS.INVALID_TOKEN);
    }

    const payload = await this.authService.verifyAccessToken(token);
    req['employee'] = await this.authService.getAuthenticatedEmployee(
      payload.sub,
      payload.sid,
    );
    return true;
  }

  private extractToken(req: Request) {
    const [type, bearerToken] = req.headers.authorization?.split(' ') ?? [];
    if (type === 'Bearer' && bearerToken) return bearerToken;
    return req.cookies?.[TokenKeys.ACCESS_TOKEN_KEY] as string | undefined;
  }
}
