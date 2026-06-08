import { CookieOptions } from 'express';
import { JWTToken } from '../../../app/auth/consts/jwt.const';

enum CookiesToken {
  ACCESS_TOKEN_EXPIRES_IN = JWTToken.ACCESS_TOKEN_EXPIRE_IN,
  REFRESH_TOKEN_EXPIRES_IN = JWTToken.REFRESH_TOKEN_EXPIRE_IN,
}

const COOKIE_CONFIG_DEFAULT: CookieOptions = {
  httpOnly: true,
  sameSite: 'strict',
};

export { CookiesToken, COOKIE_CONFIG_DEFAULT };
