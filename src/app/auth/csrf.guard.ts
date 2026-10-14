import { timingSafeEqual } from 'node:crypto';
import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import type { AuthenticatedStaffRequest } from '../../common/types';
import { AUTH_ERRORS } from '../../common/consts/message';
import { TokenKeys } from './consts/jwt.const';
import { IS_SKIP_CSRF } from './csrf.decorator';
import {
  CUSTOMER_AUTH_SCOPE,
  CUSTOMER_CSRF_COOKIE,
  CUSTOMER_SESSION_COOKIE,
} from '../../common/consts/customer-auth';

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

    const req = context.switchToHttp().getRequest<AuthenticatedStaffRequest>();
    if (SAFE_METHODS.has(req.method)) return true;
    const customerScope = this.reflector.getAllAndOverride<boolean>(
      CUSTOMER_AUTH_SCOPE,
      [context.getHandler(), context.getClass()],
    );
    if (!customerScope && req.authMethod === 'bearer') return true;

    const hasAuthCookie = Boolean(
      customerScope
        ? req.cookies?.[CUSTOMER_SESSION_COOKIE]
        : req.cookies?.[TokenKeys.ACCESS_TOKEN_KEY] ||
            req.cookies?.[TokenKeys.REFRESH_TOKEN_KEY],
    );
    if (!hasAuthCookie) return true;

    const cookieToken = req.cookies?.[
      customerScope ? CUSTOMER_CSRF_COOKIE : TokenKeys.CSRF_TOKEN_KEY
    ] as string | undefined;
    const headerToken = req.headers['x-csrf-token'];
    if (
      typeof headerToken !== 'string' ||
      typeof cookieToken !== 'string' ||
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
