import { AuthGuard } from './auth.guard';
import { Reflector } from '@nestjs/core';
import { AuthService } from './auth.service';

describe('AuthGuard', () => {
  it('should be defined', () => {
    const reflector = {
      getAllAndOverride: jest.fn(),
    } as unknown as Reflector;
    const authService = {
      verifyToken: jest.fn(),
    } as unknown as AuthService;

    expect(new AuthGuard(reflector, authService)).toBeDefined();
  });
});
