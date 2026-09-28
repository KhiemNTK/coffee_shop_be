import {
  Injectable,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { OAuth2Client } from 'google-auth-library';

@Injectable()
export class GoogleIdentityService {
  private readonly client = new OAuth2Client({
    transporterOptions: { timeout: 3_500 },
  });
  private readonly clientId?: string;

  constructor(config: ConfigService) {
    this.clientId = config.get<string>('GOOGLE_CLIENT_ID');
  }

  async verify(idToken: string) {
    if (!this.clientId) {
      throw new ServiceUnavailableException(
        'Google sign-in is not configured.',
      );
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
    } catch {
      throw new UnauthorizedException('Invalid Google credentials.');
    }
  }
}
