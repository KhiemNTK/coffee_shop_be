import {
  Injectable,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { gaxios, OAuth2Client } from 'google-auth-library';

@Injectable()
export class GoogleIdentityService {
  private readonly client = new OAuth2Client({
    transporterOptions: { timeout: 3_500, retryConfig: { retry: 0 } },
  });
  private readonly clientId?: string;

  constructor(config: ConfigService) {
    this.clientId = config.get<string>('GOOGLE_CLIENT_ID');
  }

  async verify(idToken: string) {
    if (!this.clientId) {
      throw new ServiceUnavailableException({
        code: 'GOOGLE_UNAVAILABLE',
        message:
          'Google sign-in is temporarily unavailable. Please try again later.',
      });
    }

    try {
      const ticket = await this.client.verifyIdToken({
        idToken,
        audience: this.clientId,
      });
      const payload = ticket.getPayload();
      if (!payload?.sub || !payload.email || payload.email_verified !== true) {
        throw new UnauthorizedException('Invalid Google credentials.');
      }
      return { subject: payload.sub, email: payload.email };
    } catch (error) {
      // Certificate transport failures are not evidence of invalid credentials.
      if (error instanceof gaxios.GaxiosError) {
        throw new ServiceUnavailableException({
          code: 'GOOGLE_UNAVAILABLE',
          message:
            'Google sign-in is temporarily unavailable. Please try again later.',
        });
      }
      throw new UnauthorizedException('Invalid Google credentials.');
    }
  }
}
