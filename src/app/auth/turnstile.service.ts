import {
  ForbiddenException,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { z } from 'zod';
import {
  turnstileVerificationsTotal,
  turnstileVerificationDurationSeconds,
} from '../../common/observability/metrics';

const SiteverifyResponseSchema = z.object({
  success: z.boolean(),
  hostname: z.string().optional(),
  action: z.string().optional(),
  'error-codes': z.array(z.string()).default([]),
});

@Injectable()
export class TurnstileService {
  private readonly logger = new Logger(TurnstileService.name);
  private readonly secret?: string;
  private readonly allowedHostnames: Set<string>;
  private readonly production: boolean;

  constructor(config: ConfigService) {
    this.secret = config.get<string>('TURNSTILE_SECRET_KEY');
    this.production = config.get<string>('NODE_ENV') === 'production';
    this.allowedHostnames = new Set(
      config
        .getOrThrow<string>('FE_URL')
        .split(',')
        .map((origin) => new URL(origin.trim()).hostname),
    );
  }

  async verify(
    token: string | undefined,
    ipAddress?: string,
    action = 'login',
  ) {
    if (!this.secret) {
      if (this.production) {
        throw this.unavailable('configuration');
      }
      return;
    }
    const metricAction = [
      'login',
      'password_reset',
      'online_order',
      'reservation_request',
    ].includes(action)
      ? action
      : 'other';
    let outcome = 'unavailable';
    const stopTimer = turnstileVerificationDurationSeconds.startTimer({
      action: metricAction,
    });
    try {
      if (!token) {
        outcome = 'required';
        throw new ForbiddenException({
          code: 'TURNSTILE_REQUIRED',
          message: 'Complete security verification before continuing.',
        });
      }
      let data: unknown;
      try {
        const response = await fetch(
          'https://challenges.cloudflare.com/turnstile/v0/siteverify',
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
              secret: this.secret,
              response: token,
              ...(ipAddress ? { remoteip: ipAddress } : {}),
            }),
            signal: AbortSignal.timeout(3_500),
          },
        );
        if (!response.ok) throw new Error('Siteverify request failed');
        data = await response.json();
      } catch {
        throw this.unavailable('transport');
      }

      const result = SiteverifyResponseSchema.safeParse(data);
      if (!result.success) throw this.unavailable('invalid_response');
      const errors = result.data['error-codes'];
      const providerError = errors.find((error) =>
        [
          'missing-input-secret',
          'invalid-input-secret',
          'bad-request',
          'internal-error',
        ].includes(error),
      );
      if (!result.data.success && providerError)
        throw this.unavailable(providerError);
      if (!result.data.success && errors.includes('timeout-or-duplicate')) {
        outcome = 'expired';
        throw new ForbiddenException({
          code: 'TURNSTILE_EXPIRED',
          message: 'Security verification expired. Verify again and retry.',
        });
      }
      if (
        !result.data.success ||
        result.data.action !== action ||
        !result.data.hostname ||
        !this.allowedHostnames.has(result.data.hostname)
      ) {
        outcome = 'invalid';
        throw new ForbiddenException({
          code: 'TURNSTILE_INVALID',
          message: 'Security verification failed. Verify again and retry.',
        });
      }
      outcome = 'verified';
    } finally {
      turnstileVerificationsTotal.inc({ action: metricAction, outcome });
      stopTimer();
    }
  }

  private unavailable(reason: string) {
    this.logger.error({ event: 'turnstile.unavailable', reason });
    return new ServiceUnavailableException({
      code: 'TURNSTILE_UNAVAILABLE',
      message: 'Security verification is temporarily unavailable. Retry later.',
    });
  }
}
