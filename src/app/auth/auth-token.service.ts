import { createHash, timingSafeEqual } from 'node:crypto';
import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import type {
  AuthAccessTokenPayload,
  AuthRefreshTokenPayload,
  AuthTokenPair,
} from '../../common/types';
import { AUTH_ERRORS } from '../../common/consts/message';
import { JWTEnvs, JWTToken } from './consts/jwt.const';

@Injectable()
export class AuthTokenService {
  constructor(
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
  ) {}

  async createTokenPair({
    employeeId,
    email,
    sessionId,
    familyId,
  }: {
    employeeId: string;
    email: string;
    sessionId: string;
    familyId: string;
  }): Promise<AuthTokenPair> {
    const accessPayload: AuthAccessTokenPayload = {
      sub: employeeId,
      email,
      sid: sessionId,
      tokenType: 'access',
    };
    const refreshPayload: AuthRefreshTokenPayload = {
      sub: employeeId,
      email,
      sid: sessionId,
      familyId,
      tokenType: 'refresh',
    };

    const [accessToken, refreshToken] = await Promise.all([
      this.jwtService.signAsync(accessPayload, {
        secret: this.configService.getOrThrow<string>(JWTEnvs.JWT_SECRET),
        expiresIn: JWTToken.ACCESS_TOKEN_EXPIRE_IN,
      }),
      this.jwtService.signAsync(refreshPayload, {
        secret: this.configService.getOrThrow<string>(
          JWTEnvs.JWT_REFRESH_SECRET,
        ),
        expiresIn: JWTToken.REFRESH_TOKEN_EXPIRE_IN,
      }),
    ]);

    return { accessToken, refreshToken };
  }

  async verifyAccessToken(token: string): Promise<AuthAccessTokenPayload> {
    const payload = await this.verify<AuthAccessTokenPayload>(
      token,
      this.configService.getOrThrow<string>(JWTEnvs.JWT_SECRET),
    );
    if (payload.tokenType !== 'access' || !payload.sub || !payload.sid) {
      throw new UnauthorizedException(AUTH_ERRORS.INVALID_TOKEN);
    }
    return payload;
  }

  async verifyRefreshToken(token: string): Promise<AuthRefreshTokenPayload> {
    const payload = await this.verify<AuthRefreshTokenPayload>(
      token,
      this.configService.getOrThrow<string>(JWTEnvs.JWT_REFRESH_SECRET),
    );
    if (
      payload.tokenType !== 'refresh' ||
      !payload.sub ||
      !payload.sid ||
      !payload.familyId
    ) {
      throw new UnauthorizedException(AUTH_ERRORS.INVALID_TOKEN);
    }
    return payload;
  }

  hashToken(token: string) {
    return createHash('sha256').update(token).digest('hex');
  }

  tokenHashMatches(token: string, expectedHash: string) {
    const actual = Buffer.from(this.hashToken(token), 'hex');
    const expected = Buffer.from(expectedHash, 'hex');
    return (
      actual.length === expected.length && timingSafeEqual(actual, expected)
    );
  }

  private async verify<T extends object>(token: string, secret: string) {
    try {
      return await this.jwtService.verifyAsync<T>(token, { secret });
    } catch {
      throw new UnauthorizedException(AUTH_ERRORS.INVALID_TOKEN);
    }
  }
}
