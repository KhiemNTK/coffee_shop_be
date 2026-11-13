import { ConfigService } from '@nestjs/config';
import {
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { gaxios, OAuth2Client } from 'google-auth-library';
import { GoogleIdentityService } from './google-identity.service';

const config = (clientId?: string) =>
  ({
    get: (key: string) => (key === 'GOOGLE_CLIENT_ID' ? clientId : undefined),
  }) as ConfigService;

describe('GoogleIdentityService', () => {
  afterEach(() => jest.restoreAllMocks());

  it('rejects sign-in when Google is not configured', async () => {
    await expect(
      new GoogleIdentityService(config()).verify('token'),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it('verifies the web client audience and uses the stable subject', async () => {
    const verify = jest.spyOn(
      OAuth2Client.prototype,
      'verifyIdToken',
    ) as jest.SpyInstance;
    verify.mockResolvedValue({
      getPayload: () => ({
        sub: 'google-subject',
        email: 'employee@example.com',
        email_verified: true,
      }),
    });
    const service = new GoogleIdentityService(
      config('client-id.apps.googleusercontent.com'),
    );

    await expect(service.verify('id-token')).resolves.toEqual({
      subject: 'google-subject',
      email: 'employee@example.com',
    });
    expect(verify).toHaveBeenCalledWith({
      idToken: 'id-token',
      audience: 'client-id.apps.googleusercontent.com',
    });
  });

  it('rejects unverified claims and invalid signatures', async () => {
    const verify = jest.spyOn(
      OAuth2Client.prototype,
      'verifyIdToken',
    ) as jest.SpyInstance;
    verify.mockResolvedValue({
      getPayload: () => ({
        sub: 'google-subject',
        email: 'employee@example.com',
        email_verified: false,
      }),
    });
    const service = new GoogleIdentityService(
      config('client-id.apps.googleusercontent.com'),
    );
    await expect(service.verify('id-token')).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    verify.mockRejectedValueOnce(new Error('Invalid signature'));
    await expect(service.verify('bad-token')).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it.each([undefined, 429, 503])(
    'reports certificate transport failure %s as unavailable without leaking provider details',
    async (status) => {
      const options: gaxios.GaxiosOptionsPrepared = {
        url: new URL('https://www.googleapis.com/oauth2/v1/certs'),
        headers: new Headers(),
      };
      const response = status
        ? Object.assign(new Response(null, { status }), {
            config: options,
            data: {},
          })
        : undefined;
      const verify = jest.spyOn(
        OAuth2Client.prototype,
        'verifyIdToken',
      ) as jest.SpyInstance;
      verify.mockRejectedValueOnce(
        new gaxios.GaxiosError('private provider details', options, response),
      );
      const service = new GoogleIdentityService(config('client-id'));

      await expect(service.verify('token')).rejects.toMatchObject({
        status: 503,
        response: {
          code: 'GOOGLE_UNAVAILABLE',
          message:
            'Google sign-in is temporarily unavailable. Please try again later.',
        },
      });
    },
  );

  it('does not retry certificate downloads beyond the login timeout budget', async () => {
    const service = new GoogleIdentityService(config('client-id'));
    const adapter = jest.fn(() =>
      Promise.reject(new Error('network unavailable')),
    );
    service['client'].transporter.defaults.adapter = adapter;
    service['client'].transporter.defaults.noProxy = [/.*/];

    await expect(service.verify('token')).rejects.toMatchObject({
      status: 503,
      response: { code: 'GOOGLE_UNAVAILABLE' },
    });
    expect(adapter).toHaveBeenCalledTimes(1);
  });
});
