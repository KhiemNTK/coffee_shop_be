import { type ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AuthService } from './auth.service';
import { AuthGuard } from './auth.guard';

describe('AuthGuard', () => {
  const createFixture = () => {
    const reflector = {
      getAllAndOverride: jest.fn().mockReturnValue(false),
    };
    const authService = {
      verifyAccessToken: jest.fn(),
      getAuthenticatedEmployee: jest.fn(),
    };
    const request = {
      headers: { authorization: 'Bearer access-token' },
      cookies: {},
    } as Record<string, unknown>;
    const context = {
      getHandler: jest.fn(),
      getClass: jest.fn(),
      switchToHttp: jest.fn().mockReturnValue({
        getRequest: jest.fn().mockReturnValue(request),
      }),
    } as unknown as ExecutionContext;
    const guard = new AuthGuard(
      reflector as unknown as Reflector,
      authService as unknown as AuthService,
    );

    return { authService, context, guard, reflector, request };
  };

  it('allows an explicitly public route without reading a token', async () => {
    const { authService, context, guard, reflector } = createFixture();
    reflector.getAllAndOverride.mockReturnValue(true);

    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(authService.verifyAccessToken).not.toHaveBeenCalled();
  });

  it('rejects an invalid access token', async () => {
    const { authService, context, guard } = createFixture();
    authService.verifyAccessToken.mockRejectedValue(
      new UnauthorizedException('invalid'),
    );

    await expect(guard.canActivate(context)).rejects.toThrow(
      UnauthorizedException,
    );
  });

  it('does not misreport an infrastructure failure as an invalid token', async () => {
    const { authService, context, guard } = createFixture();
    const databaseError = new Error('database unavailable');
    authService.verifyAccessToken.mockResolvedValue({
      sub: 'employee-1',
      sid: 'session-1',
    });
    authService.getAuthenticatedEmployee.mockRejectedValue(databaseError);

    await expect(guard.canActivate(context)).rejects.toBe(databaseError);
  });

  it('rejects an inactive employee at request time', async () => {
    const { authService, context, guard } = createFixture();
    authService.verifyAccessToken.mockResolvedValue({
      sub: 'employee-1',
      sid: 'session-1',
    });
    authService.getAuthenticatedEmployee.mockRejectedValue(
      new UnauthorizedException(),
    );

    await expect(guard.canActivate(context)).rejects.toThrow(
      UnauthorizedException,
    );
  });

  it('attaches the authenticated employee context to the request', async () => {
    const { authService, context, guard, request } = createFixture();
    const employee = {
      employeeId: 'employee-1',
      employeeEmail: 'owner@example.com',
      email: 'owner@example.com',
      sessionId: 'session-1',
    };
    authService.verifyAccessToken.mockResolvedValue({
      sub: employee.employeeId,
      sid: employee.sessionId,
    });
    authService.getAuthenticatedEmployee.mockResolvedValue(employee);

    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(request.employee).toEqual(employee);
  });
});
