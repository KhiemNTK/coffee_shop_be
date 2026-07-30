import { PermissionKeys } from '../consts/permission-keys';

export type PermissionKey =
  (typeof PermissionKeys)[keyof typeof PermissionKeys];

export interface AuthorizationContext {
  employeeId: string;
  employeeEmail: string;
  permissionKeys: PermissionKey[];
  roleNames: string[];
}

export interface RoleWithPermissions {
  id: string;
  name: string;
  permissions: PermissionKey[];
}
