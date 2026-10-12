import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { AuthorizationService } from './authorization.service';
import { PermissionKeys } from '../../common/consts/permission-keys';

describe('AuthorizationService delegation', () => {
  const context = {
    employeeId: 'actor',
    employeeEmail: 'actor@example.test',
    roleNames: ['MANAGER'],
    permissionKeys: [
      PermissionKeys.EMPLOYEE_ROLES_UPDATE,
      PermissionKeys.MENU_READ,
    ],
  };

  it('allows only an explicit subset, without a role-name bypass', () => {
    const service = new AuthorizationService({} as never);
    expect(
      service.canGrantPermissions(context, [PermissionKeys.MENU_READ]),
    ).toBe(true);
    expect(() =>
      service.assertCanGrantPermissions({ ...context, roleNames: ['OWNER'] }, [
        PermissionKeys.ROLE_PERMISSIONS_UPDATE,
      ]),
    ).toThrow(ForbiddenException);
  });

  it('uses the transaction client, never cached grants, for sensitive writes', async () => {
    const tx = {
      employee: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'actor',
          email: context.employeeEmail,
          isActive: true,
          deletedAt: null,
          employeeRoles: [
            {
              role: {
                name: 'MANAGER',
                rolePermissions: [
                  { permission: { key: PermissionKeys.MENU_READ } },
                ],
              },
            },
          ],
        }),
      },
    };
    const service = new AuthorizationService({} as never);
    const fresh = await service.getFreshAuthorizationContext(
      'actor',
      tx as never,
    );
    expect(fresh.permissionKeys).toEqual([PermissionKeys.MENU_READ]);
    expect(tx.employee.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'actor', deletedAt: null } }),
    );
  });

  it.each([
    null,
    { isActive: false },
    { isActive: true, deletedAt: new Date() },
  ])('rejects inactive/deleted actors: %p', async (employee) => {
    const service = new AuthorizationService({
      employee: { findUnique: jest.fn().mockResolvedValue(employee) },
    } as never);
    await expect(
      service.getFreshAuthorizationContext('actor'),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('reads committed grants on every request, without stale cache refill', async () => {
    const employee = {
      id: 'actor',
      email: context.employeeEmail,
      isActive: true,
      deletedAt: null,
    };
    const findUnique = jest
      .fn()
      .mockResolvedValueOnce({
        ...employee,
        employeeRoles: [
          {
            role: {
              name: 'MANAGER',
              rolePermissions: [
                { permission: { key: PermissionKeys.MENU_READ } },
              ],
            },
          },
        ],
      })
      .mockResolvedValueOnce({ ...employee, employeeRoles: [] });
    const service = new AuthorizationService({
      employee: { findUnique },
    } as never);
    expect(await service.getPermissionKeys('actor')).toEqual([
      PermissionKeys.MENU_READ,
    ]);
    expect(await service.getPermissionKeys('actor')).toEqual([]);
    expect(findUnique).toHaveBeenCalledTimes(2);
  });
});
