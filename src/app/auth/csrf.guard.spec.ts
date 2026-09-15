import { ForbiddenException, type ExecutionContext } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import { TokenKeys } from './consts/jwt.const';
import { CsrfGuard } from './csrf.guard';

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
          cookies: {},
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
