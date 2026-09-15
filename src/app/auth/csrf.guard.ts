import { timingSafeEqual } from 'node:crypto';
import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { AUTH_ERRORS } from '../../common/consts/message';
import { TokenKeys } from './consts/jwt.const';
import { IS_SKIP_CSRF } from './csrf.decorator';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

@Injectable()
export class CsrfGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly configService: ConfigService,
  ) {}

  canActivate(context: ExecutionContext) {
    if (!this.configService.get<boolean>('CSRF_ENABLED', true)) return true;

    const skipCsrf = this.reflector.getAllAndOverride<boolean>(IS_SKIP_CSRF, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (skipCsrf) return true;

    const req = context.switchToHttp().getRequest<Request>();
    if (SAFE_METHODS.has(req.method)) return true;
    if (req.headers.authorization?.startsWith('Bearer ')) return true;

    const hasAuthCookie = Boolean(
      req.cookies?.[TokenKeys.ACCESS_TOKEN_KEY] ||
      req.cookies?.[TokenKeys.REFRESH_TOKEN_KEY],
    );
    if (!hasAuthCookie) return true;

    const cookieToken = req.cookies?.[TokenKeys.CSRF_TOKEN_KEY] as
      | string
      | undefined;
    const headerToken = req.headers['x-csrf-token'];
    if (
      typeof headerToken !== 'string' ||
      !cookieToken ||
      !this.matches(cookieToken, headerToken)
    ) {
      throw new ForbiddenException(AUTH_ERRORS.INVALID_CSRF_TOKEN);
    }

    return true;
  }

  private matches(left: string, right: string) {
    const leftBuffer = Buffer.from(left);
    const rightBuffer = Buffer.from(right);
    return (
      leftBuffer.length === rightBuffer.length &&
      timingSafeEqual(leftBuffer, rightBuffer)
    );
  }
}
