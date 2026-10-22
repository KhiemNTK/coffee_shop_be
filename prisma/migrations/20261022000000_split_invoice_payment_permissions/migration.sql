BEGIN;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "Permission" WHERE "key" IN ('/invoices_pay', '/invoices_void') AND "deletedAt" IS NULL AND NOT "isSystemPermission") THEN
    RAISE EXCEPTION 'New invoice permission keys already exist as custom permissions; review their grants before migrating';
  END IF;
END $$;

INSERT INTO "Permission" ("id", "key", "name", "description", "isSystemPermission", "createdAt", "updatedAt")
VALUES
  (gen_random_uuid()::text, '/invoices_pay', 'Confirm cash or card payments', 'Confirm cash or card payments', true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  (gen_random_uuid()::text, '/invoices_void', 'Void unpaid invoices', 'Void unpaid invoices', true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
ON CONFLICT ("key") WHERE "deletedAt" IS NULL DO NOTHING;

-- Preserve existing grants. New roles can grant pay without granting void.
INSERT INTO "RolePermission" ("roleId", "permissionId", "createdAt")
SELECT DISTINCT rp."roleId", target."id", CURRENT_TIMESTAMP
FROM "RolePermission" rp
JOIN "Role" r ON r."id" = rp."roleId" AND r."deletedAt" IS NULL
JOIN "Permission" source ON source."id" = rp."permissionId" AND source."deletedAt" IS NULL
JOIN "Permission" target ON target."deletedAt" IS NULL AND (
  (target."key" = '/invoices_pay' AND source."key" IN ('/invoices_create', '/invoices_update')) OR
  (target."key" = '/invoices_void' AND source."key" = '/invoices_update')
)
ON CONFLICT ("roleId", "permissionId") DO NOTHING;

COMMIT;
