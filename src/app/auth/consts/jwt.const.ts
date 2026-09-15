export enum JWTEnvs {
  JWT_SECRET = 'JWT_SECRET',
  JWT_REFRESH_SECRET = 'JWT_REFRESH_SECRET',
}

export enum JWTToken {
  ACCESS_TOKEN_EXPIRE_IN = '15m',
  REFRESH_TOKEN_EXPIRE_IN = '30d',
  PASSWORD_RESET_EXPIRE_IN_MINUTES = 15,
}

export enum TokenKeys {
  ACCESS_TOKEN_KEY = 'accessToken',
  REFRESH_TOKEN_KEY = 'refreshToken',
  CSRF_TOKEN_KEY = 'csrfToken',
}
