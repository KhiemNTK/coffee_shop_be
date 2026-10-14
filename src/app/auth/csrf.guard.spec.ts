import { ForbiddenException, type ExecutionContext } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import { TokenKeys } from './consts/jwt.const';
import { CsrfGuard } from './csrf.guard';
import {
  CUSTOMER_AUTH_SCOPE,
  CUSTOMER_CSRF_COOKIE,
  CUSTOMER_SESSION_COOKIE,
} from '../../common/consts/customer-auth';

const contextFor = (request: Record<string, unknown>) =>
  ({
    getHandler: jest.fn(),
    getClass: jest.fn(),
    switchToHttp: () => ({ getRequest: () => request }),
  }) as unknown as ExecutionContext;

describe('CsrfGuard', () => {
  const reflector = {
    getAllAndOverride: jest.fn().mockReturnValue(false),
  } as unknown as Reflector;
  const config = {
    get: jest.fn().mockReturnValue(true),
  } as unknown as ConfigService;
  const guard = new CsrfGuard(reflector, config);

  it('allows bearer-authenticated mutations', () => {
    expect(
      guard.canActivate(
        contextFor({
          method: 'POST',
          headers: { authorization: 'Bearer token' },
          authMethod: 'bearer',
          cookies: { [TokenKeys.ACCESS_TOKEN_KEY]: 'cookie-token' },
        }),
      ),
    ).toBe(true);
  });

  it.each(['Bearer attacker-controlled', 'Bearer  ignored'])(
    'does not trust an authorization header on cookie-only refresh/logout: %s',
    (authorization) => {
      expect(() =>
        guard.canActivate(
          contextFor({
            method: 'POST',
            headers: { authorization },
            cookies: { [TokenKeys.REFRESH_TOKEN_KEY]: 'refresh-token' },
          }),
        ),
      ).toThrow(ForbiddenException);
    },
  );

  it('never lets a fake bearer header bypass customer-cookie CSRF', () => {
    const customerReflector = {
      getAllAndOverride: (key: string) => key === CUSTOMER_AUTH_SCOPE,
    } as unknown as Reflector;
    const customerGuard = new CsrfGuard(customerReflector, config);
    const request = {
      method: 'PUT',
      headers: { authorization: 'Bearer attacker-controlled' },
      cookies: { [CUSTOMER_SESSION_COOKIE]: 'customer-cookie' },
    };
    expect(() => customerGuard.canActivate(contextFor(request))).toThrow(
      ForbiddenException,
    );
    expect(
      customerGuard.canActivate(
        contextFor({
          ...request,
          headers: { ...request.headers, 'x-csrf-token': 'csrf' },
          cookies: { ...request.cookies, [CUSTOMER_CSRF_COOKIE]: 'csrf' },
        }),
      ),
    ).toBe(true);
  });

  it('rejects cookie-authenticated mutations without matching tokens', () => {
    expect(() =>
      guard.canActivate(
        contextFor({
          method: 'POST',
          headers: {},
          cookies: { [TokenKeys.ACCESS_TOKEN_KEY]: 'access-token' },
        }),
      ),
    ).toThrow(ForbiddenException);
  });

  it('allows cookie-authenticated mutations with matching tokens', () => {
    expect(
      guard.canActivate(
        contextFor({
          method: 'POST',
          headers: { 'x-csrf-token': 'csrf-token' },
          cookies: {
            [TokenKeys.ACCESS_TOKEN_KEY]: 'access-token',
            [TokenKeys.CSRF_TOKEN_KEY]: 'csrf-token',
          },
        }),
      ),
    ).toBe(true);
  });
});
