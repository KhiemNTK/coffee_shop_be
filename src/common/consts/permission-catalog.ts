import { PermissionKeys } from './permission-keys';

const systemPermissionKeys = new Set<string>(Object.values(PermissionKeys));

export const isSystemPermissionKey = (key: string) =>
  systemPermissionKeys.has(key);

export function getPermissionCatalogIssues(
  permissions: readonly { key: string; isSystemPermission: boolean }[],
) {
  const seen = new Set<string>();
  const issues: string[] = [];
  for (const permission of permissions) {
    if (seen.has(permission.key))
      issues.push(`Duplicate key: ${permission.key}`);
    seen.add(permission.key);
    if (!isSystemPermissionKey(permission.key))
      issues.push(`Unknown key: ${permission.key}`);
    else if (!permission.isSystemPermission)
      issues.push(`Unprotected system key: ${permission.key}`);
  }
  for (const key of systemPermissionKeys) {
    if (!seen.has(key)) issues.push(`Missing system key: ${key}`);
  }
  return issues;
}
