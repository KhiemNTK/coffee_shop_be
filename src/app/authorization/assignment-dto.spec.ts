import { ReplaceEmployeeRolesInputSchema } from '../employees/dto/employee-roles.dto';
import { ReplaceRolePermissionsInputSchema } from '../roles/dto/role-permissions.dto';

describe('Explicit access replacement payloads', () => {
  it('does not turn an omitted or null list into a revoke-all command', () => {
    for (const input of [{}, { permissionIds: null }]) {
      expect(ReplaceRolePermissionsInputSchema.safeParse(input).success).toBe(
        false,
      );
    }
    for (const input of [{}, { roleIds: null }]) {
      expect(ReplaceEmployeeRolesInputSchema.safeParse(input).success).toBe(
        false,
      );
    }
    expect(
      ReplaceRolePermissionsInputSchema.parse({ permissionIds: [] }),
    ).toEqual({ permissionIds: [] });
    expect(ReplaceEmployeeRolesInputSchema.parse({ roleIds: [] })).toEqual({
      roleIds: [],
    });
  });

  it('validates optional baseline IDs while accepting existing clients', () => {
    expect(
      ReplaceRolePermissionsInputSchema.safeParse({
        permissionIds: [],
        expectedPermissionIds: ['invalid'],
      }).success,
    ).toBe(false);
    expect(
      ReplaceEmployeeRolesInputSchema.safeParse({
        roleIds: [],
        expectedRoleIds: ['invalid'],
      }).success,
    ).toBe(false);
    expect(
      ReplaceRolePermissionsInputSchema.parse({
        permissionIds: [],
        expectedPermissionIds: [],
      }).expectedPermissionIds,
    ).toEqual([]);
    expect(
      ReplaceEmployeeRolesInputSchema.parse({
        roleIds: [],
        expectedRoleIds: [],
      }).expectedRoleIds,
    ).toEqual([]);
  });
});
