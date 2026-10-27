import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnsupportedMediaTypeException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request } from 'express';

@Injectable()
export class LoginRequestGuard implements CanActivate {
  private readonly allowedOrigins: Set<string>;

  constructor(config: ConfigService) {
    this.allowedOrigins = new Set(
      (config.get<string>('FE_URL') ?? '')
        .split(',')
        .filter((origin) => origin.trim())
        .map((origin) => new URL(origin.trim()).origin),
    );
  }

  canActivate(context: ExecutionContext) {
    const request = context.switchToHttp().getRequest<Request>();
    if (!request.is('application/json')) {
      throw new UnsupportedMediaTypeException({
        code: 'AUTH_JSON_REQUIRED',
        message: 'Sign-in requests must use application/json.',
      });
    }
    const origin = request.get('origin');
    const referer = request.get('referer');
    let source = origin;
    try {
      if (source === undefined && referer !== undefined)
        source = new URL(referer).origin;
    } catch {
      source = 'null';
    }
    // JSON-only callers without browser headers remain supported; forms cannot use this content type.
    if (
      (source !== undefined && !this.allowedOrigins.has(source)) ||
      (source === undefined && request.get('sec-fetch-site') === 'cross-site')
    ) {
      throw new ForbiddenException({
        code: 'AUTH_ORIGIN_NOT_ALLOWED',
        message: 'Sign-in origin is not allowed.',
      });
    }
    return true;
  }
}
