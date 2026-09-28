import { ConfigService } from '@nestjs/config';
import {
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { OAuth2Client } from 'google-auth-library';
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
});
