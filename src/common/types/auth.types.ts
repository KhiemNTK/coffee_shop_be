export type AuthTokenType = 'access' | 'refresh';

export interface AuthAccessTokenPayload {
  sub: string;
  email: string;
  sid: string;
  tokenType: 'access';
}

export interface AuthRefreshTokenPayload {
  sub: string;
  email: string;
  sid: string;
  familyId: string;
  tokenType: 'refresh';
}

export interface AuthRequestMetadata {
  ipAddress?: string;
  userAgent?: string;
}

export interface AuthTokenPair {
  accessToken: string;
  refreshToken: string;
}
