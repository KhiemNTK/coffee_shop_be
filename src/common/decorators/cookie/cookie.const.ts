import { randomBytes } from 'node:crypto';
import type { CookieOptions } from 'express';
import { JWTToken } from '../../../app/auth/consts/jwt.const';

enum CookiesToken {
  ACCESS_TOKEN_EXPIRES_IN = JWTToken.ACCESS_TOKEN_EXPIRE_IN,
  REFRESH_TOKEN_EXPIRES_IN = JWTToken.REFRESH_TOKEN_EXPIRE_IN,
}

const getBaseCookieOptions = (): CookieOptions => ({
  secure:
    process.env.NODE_ENV === 'production' ||
    process.env.COOKIE_SECURE === 'true',
  sameSite: (process.env.COOKIE_SAME_SITE ??
    'strict') as CookieOptions['sameSite'],
  path: '/',
});

const getAuthCookieOptions = (): CookieOptions => ({
  ...getBaseCookieOptions(),
  httpOnly: true,
});

const getCsrfCookieOptions = (): CookieOptions => ({
  ...getBaseCookieOptions(),
  httpOnly: false,
});

const createCsrfToken = () => randomBytes(32).toString('base64url');

export {
  CookiesToken,
  createCsrfToken,
  getAuthCookieOptions,
  getCsrfCookieOptions,
};
