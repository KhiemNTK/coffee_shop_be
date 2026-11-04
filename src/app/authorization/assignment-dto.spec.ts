import { ReplaceEmployeeRolesInputSchema } from '../employees/dto/employee-roles.dto';
import { ReplaceRolePermissionsInputSchema } from '../roles/dto/role-permissions.dto';
import { CreateRoleInputSchema } from '../roles/dto/create-role.dto';
import { UpdateRoleInputSchema } from '../roles/dto/update-role.dto';

describe('Explicit access replacement payloads', () => {
  it('accepts templates only on creation and validates their IDs', () => {
    expect(
      CreateRoleInputSchema.safeParse({
        name: 'Custom',
        templateRoleId: 'invalid',
      }).success,
    ).toBe(false);
    const templateRoleId = '30000000-0000-4000-8000-000000000003';
    const expectedUpdatedAt = '2026-10-01T00:00:00.000Z';
    expect(
      CreateRoleInputSchema.parse({ name: 'Custom', templateRoleId }),
    ).toEqual({ name: 'Custom', templateRoleId });
    expect(
      UpdateRoleInputSchema.parse({
        name: 'Custom',
        templateRoleId,
        expectedUpdatedAt,
      }),
    ).toEqual({
      name: 'Custom',
      expectedUpdatedAt: new Date(expectedUpdatedAt),
    });
  });

  it.each([undefined, null, 'invalid-date'])(
    'rejects role metadata edits with an invalid observed version: %s',
    (expectedUpdatedAt) => {
      expect(
        UpdateRoleInputSchema.safeParse({ name: 'Custom', expectedUpdatedAt })
          .success,
      ).toBe(false);
    },
  );

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
