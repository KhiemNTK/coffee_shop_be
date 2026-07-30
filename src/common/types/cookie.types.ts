import { TokenKeys } from '../../app/auth/consts/jwt.const';

export interface CookiesInfo {
  [TokenKeys.ACCESS_TOKEN_KEY]: string;
  [TokenKeys.REFRESH_TOKEN_KEY]: string;
}
