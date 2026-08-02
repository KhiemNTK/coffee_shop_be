import { ForbiddenException, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PermissionKeys } from '../../common/consts/permission-keys';
import { AuthorizationService } from './authorization.service';
import { PermissionsGuard } from './permissions.guard';

const createContext = (employee?: Record<string, unknown>) =>
  ({
    getHandler: jest.fn(),
    getClass: jest.fn(),
    switchToHttp: jest.fn(() => ({
      getRequest: jest.fn(() => ({ employee })),
    })),
  }) as unknown as ExecutionContext;

describe('PermissionsGuard', () => {
  let reflector: jest.Mocked<Pick<Reflector, 'getAllAndOverride'>>;
  let authorizationService: jest.Mocked<
    Pick<AuthorizationService, 'getAuthorizationContext'>
  >;
  let guard: PermissionsGuard;

  beforeEach(() => {
    reflector = {
      getAllAndOverride: jest.fn(),
    };
    authorizationService = {
      getAuthorizationContext: jest.fn(),
    };
    guard = new PermissionsGuard(
      reflector as unknown as Reflector,
      authorizationService as unknown as AuthorizationService,
    );
  });

  it('allows phased routes without required permission metadata', async () => {
    reflector.getAllAndOverride
      .mockReturnValueOnce(false)
      .mockReturnValueOnce([]);

    await expect(
      guard.canActivate(createContext({ employeeId: 'employee-id' })),
    ).resolves.toBe(true);
    expect(authorizationService.getAuthorizationContext).not.toHaveBeenCalled();
  });

  it('rejects a route when employee misses required permissions', async () => {
    reflector.getAllAndOverride
      .mockReturnValueOnce(false)
      .mockReturnValueOnce([PermissionKeys.ROLES_READ]);
    authorizationService.getAuthorizationContext.mockResolvedValue({
      employeeId: 'employee-id',
      employeeEmail: 'admin@example.com',
      permissionKeys: [],
      roleNames: [],
    });

    await expect(
      guard.canActivate(createContext({ employeeId: 'employee-id' })),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('allows a route when employee has every required permission', async () => {
    reflector.getAllAndOverride
      .mockReturnValueOnce(false)
      .mockReturnValueOnce([PermissionKeys.ROLES_READ]);
    authorizationService.getAuthorizationContext.mockResolvedValue({
      employeeId: 'employee-id',
      employeeEmail: 'admin@example.com',
      permissionKeys: [PermissionKeys.ROLES_READ],
      roleNames: ['OWNER'],
    });

    await expect(
      guard.canActivate(createContext({ employeeId: 'employee-id' })),
    ).resolves.toBe(true);
  });
});
