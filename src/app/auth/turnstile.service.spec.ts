import { ConfigService } from '@nestjs/config';
import {
  ForbiddenException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { TurnstileService } from './turnstile.service';

const config = (secret?: string, environment = 'production') => {
  const values: Record<string, string | undefined> = {
    TURNSTILE_SECRET_KEY: secret,
    NODE_ENV: environment,
    FE_URL: 'https://app.example.com',
  };
  return {
    get: (key: string) => values[key],
    getOrThrow: (key: string) => values[key],
  } as ConfigService;
};

describe('TurnstileService', () => {
  afterEach(() => jest.restoreAllMocks());

  it('permits unconfigured development but fails closed in production', async () => {
    await expect(
      new TurnstileService(config(undefined, 'development')).verify(undefined),
    ).resolves.toBeUndefined();
    await expect(
      new TurnstileService(config()).verify(undefined),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it('validates with Siteverify and checks action and frontend hostname', async () => {
    const fetchSpy = jest.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          success: true,
          action: 'login',
          hostname: 'app.example.com',
        }),
      ),
    );
    const service = new TurnstileService(config('real-turnstile-secret'));
    await expect(
      service.verify('challenge', '203.0.113.1'),
    ).resolves.toBeUndefined();
    const [url, options] = fetchSpy.mock.calls[0];
    expect(url).toBe(
      'https://challenges.cloudflare.com/turnstile/v0/siteverify',
    );
    expect((options?.body as URLSearchParams).get('remoteip')).toBe(
      '203.0.113.1',
    );
    expect((options?.body as URLSearchParams).get('secret')).toBe(
      'real-turnstile-secret',
    );
    expect((options?.body as URLSearchParams).get('response')).toBe(
      'challenge',
    );
  });

  it('rejects missing, replayed, wrong-action and wrong-hostname tokens', async () => {
    const service = new TurnstileService(config('real-turnstile-secret'));
    await expect(service.verify(undefined)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    const fetchSpy = jest.spyOn(globalThis, 'fetch');
    for (const result of [
      { success: false },
      { success: true, action: 'other', hostname: 'app.example.com' },
      { success: true, action: 'login', hostname: 'evil.example.com' },
    ]) {
      fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify(result)));
      await expect(service.verify('challenge')).rejects.toBeInstanceOf(
        ForbiddenException,
      );
    }
  });

  it('does not bypass verification when Cloudflare is unavailable', async () => {
    jest
      .spyOn(globalThis, 'fetch')
      .mockRejectedValue(new Error('Network unavailable'));
    await expect(
      new TurnstileService(config('real-turnstile-secret')).verify('challenge'),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it('requires the action bound to the requested flow', async () => {
    const fetchSpy = jest.spyOn(globalThis, 'fetch');
    fetchSpy.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          success: true,
          action: 'login',
          hostname: 'app.example.com',
        }),
      ),
    );
    await expect(
      new TurnstileService(config('real-turnstile-secret')).verify(
        'challenge',
        undefined,
        'password_reset',
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });
});
