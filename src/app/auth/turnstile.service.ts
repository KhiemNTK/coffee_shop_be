import {
  ForbiddenException,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { z } from 'zod';

const SiteverifyResponseSchema = z.object({
  success: z.boolean(),
  hostname: z.string().optional(),
  action: z.string().optional(),
});

@Injectable()
export class TurnstileService {
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
        throw new ServiceUnavailableException(
          'Human verification is unavailable.',
        );
      }
      return;
    }
    if (!token) throw new ForbiddenException('Human verification required.');

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
      throw new ServiceUnavailableException(
        'Human verification is unavailable.',
      );
    }

    const result = SiteverifyResponseSchema.safeParse(data);
    if (!result.success) {
      throw new ServiceUnavailableException(
        'Human verification is unavailable.',
      );
    }
    if (
      !result.data.success ||
      result.data.action !== action ||
      !result.data.hostname ||
      !this.allowedHostnames.has(result.data.hostname)
    ) {
      throw new ForbiddenException('Human verification failed.');
    }
  }
}
