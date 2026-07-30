-- Preflight before applying this migration in a live database:
-- 1. SELECT name, COUNT(*) FROM "Role" WHERE "deletedAt" IS NULL GROUP BY name HAVING COUNT(*) > 1;
-- 2. SELECT key, COUNT(*) FROM "Permission" WHERE "deletedAt" IS NULL GROUP BY key HAVING COUNT(*) > 1;
-- 3. SELECT rp.* FROM "RolePermission" rp LEFT JOIN "Role" r ON r.id = rp."roleId" LEFT JOIN "Permission" p ON p.id = rp."permissionId" WHERE r."deletedAt" IS NOT NULL OR p."deletedAt" IS NOT NULL OR r.id IS NULL OR p.id IS NULL;
-- 4. SELECT er.* FROM "EmployeeRole" er LEFT JOIN "Role" r ON r.id = er."roleId" LEFT JOIN "Employee" e ON e.id = er."employeeId" WHERE r."deletedAt" IS NOT NULL OR e."deletedAt" IS NOT NULL OR r.id IS NULL OR e.id IS NULL;

DROP INDEX IF EXISTS "Role_name_key";
DROP INDEX IF EXISTS "Permission_name_key_key";

CREATE UNIQUE INDEX IF NOT EXISTS "role_name_active_unique"
  ON "Role"("name")
  WHERE "deletedAt" IS NULL;

CREATE INDEX IF NOT EXISTS "Role_name_idx" ON "Role"("name");
CREATE INDEX IF NOT EXISTS "Role_deletedAt_idx" ON "Role"("deletedAt");

CREATE UNIQUE INDEX IF NOT EXISTS "permission_key_active_unique"
  ON "Permission"("key")
  WHERE "deletedAt" IS NULL;

CREATE INDEX IF NOT EXISTS "Permission_key_idx" ON "Permission"("key");
CREATE INDEX IF NOT EXISTS "Permission_deletedAt_idx" ON "Permission"("deletedAt");
CREATE INDEX IF NOT EXISTS "RolePermission_permissionId_idx" ON "RolePermission"("permissionId");
CREATE INDEX IF NOT EXISTS "EmployeeRole_roleId_idx" ON "EmployeeRole"("roleId");
