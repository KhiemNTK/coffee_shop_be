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

  it('loads grants with one parameterized query on the supplied transaction client', async () => {
    const query = jest
      .fn()
      .mockResolvedValue([{ ...context, permissionKeys: [] }]);
    const baseQuery = jest.fn();
    const service = new AuthorizationService({ $queryRaw: baseQuery } as never);
    await expect(
      service.getFreshAuthorizationContext('actor', {
        $queryRaw: query,
      } as never),
    ).resolves.toEqual({ ...context, permissionKeys: [] });
    expect(query).toHaveBeenCalledTimes(1);
    expect(baseQuery).not.toHaveBeenCalled();
    const sql = query.mock.calls[0][0] as { text: string; values: unknown[] };
    expect(sql.values).toEqual(['actor']);
    expect(sql.text).toContain('e."isActive" = true');
    expect(sql.text).toContain('e."deletedAt" IS NULL');
    expect(sql.text).toContain('r."deletedAt" IS NULL');
    expect(sql.text).toContain('p."deletedAt" IS NULL');
  });

  it('rejects an inactive, deleted or missing employee when the query returns no row', async () => {
    const service = new AuthorizationService({
      $queryRaw: jest.fn().mockResolvedValue([]),
    } as never);
    await expect(
      service.getFreshAuthorizationContext('actor'),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('reads committed grants on every request and keeps deterministic ordering', async () => {
    const query = jest
      .fn()
      .mockResolvedValueOnce([
        {
          ...context,
          permissionKeys: [
            PermissionKeys.MENU_READ,
            PermissionKeys.EMPLOYEE_ROLES_UPDATE,
          ],
        },
      ])
      .mockResolvedValueOnce([{ ...context, permissionKeys: [] }]);
    const service = new AuthorizationService({ $queryRaw: query } as never);
    expect(await service.getPermissionKeys('actor')).toEqual(
      [...context.permissionKeys].sort(),
    );
    expect(await service.getPermissionKeys('actor')).toEqual([]);
    expect(query).toHaveBeenCalledTimes(2);
  });
});
