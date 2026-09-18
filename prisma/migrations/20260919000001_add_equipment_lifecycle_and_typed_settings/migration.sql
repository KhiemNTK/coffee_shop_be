CREATE TYPE "SettingValueType" AS ENUM ('STRING', 'NUMBER', 'BOOLEAN', 'JSON');

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "Equipment"
    WHERE "quantity" <= 0
      OR "unitPrice" < 0
      OR "totalAmount" <> "quantity" * "unitPrice"
  ) THEN
    RAISE EXCEPTION 'Invalid equipment quantity or monetary totals must be resolved before migration.';
  END IF;
END $$;

ALTER TABLE "Equipment"
  ADD COLUMN "assetCode" TEXT,
  ADD COLUMN "serialNumber" TEXT,
  ADD COLUMN "warrantyExpiresAt" TIMESTAMP(3),
  ADD COLUMN "nextMaintenanceAt" TIMESTAMP(3),
  ADD COLUMN "location" TEXT,
  ADD COLUMN "notes" TEXT,
  ADD COLUMN "liquidatedAt" TIMESTAMP(3);

UPDATE "Equipment"
SET "assetCode" = 'EQ-' || upper(replace("id", '-', ''));

UPDATE "Equipment"
SET "liquidatedAt" = "updatedAt"
WHERE "status" = 'LIQUIDATED';

ALTER TABLE "Equipment"
  ALTER COLUMN "assetCode" SET NOT NULL,
  ADD CONSTRAINT "Equipment_positive_quantity_check"
    CHECK ("quantity" > 0),
  ADD CONSTRAINT "Equipment_non_negative_money_check"
    CHECK ("unitPrice" >= 0 AND "totalAmount" >= 0),
  ADD CONSTRAINT "Equipment_total_amount_check"
    CHECK ("totalAmount" = "quantity" * "unitPrice"),
  ADD CONSTRAINT "Equipment_warranty_date_check"
    CHECK ("warrantyExpiresAt" IS NULL OR "warrantyExpiresAt" >= "purchaseDate"),
  ADD CONSTRAINT "Equipment_liquidation_state_check"
    CHECK (
      ("status" = 'LIQUIDATED' AND "liquidatedAt" IS NOT NULL)
      OR ("status" <> 'LIQUIDATED' AND "liquidatedAt" IS NULL)
    );

CREATE UNIQUE INDEX "Equipment_assetCode_key" ON "Equipment"("assetCode");
CREATE UNIQUE INDEX "Equipment_serialNumber_key" ON "Equipment"("serialNumber");
CREATE INDEX "Equipment_deletedAt_status_idx" ON "Equipment"("deletedAt", "status");
CREATE INDEX "Equipment_nextMaintenanceAt_idx" ON "Equipment"("nextMaintenanceAt");

CREATE TABLE "EquipmentLifecycleEvent" (
  "id" TEXT NOT NULL,
  "fromStatus" "EquipmentStatus",
  "toStatus" "EquipmentStatus" NOT NULL,
  "reason" TEXT NOT NULL,
  "cost" DECIMAL(18,2) NOT NULL DEFAULT 0,
  "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "equipmentId" TEXT NOT NULL,
  "employeeId" TEXT NOT NULL,

  CONSTRAINT "EquipmentLifecycleEvent_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "EquipmentLifecycleEvent_non_negative_cost_check" CHECK ("cost" >= 0),
  CONSTRAINT "EquipmentLifecycleEvent_status_change_check"
    CHECK ("fromStatus" IS NULL OR "fromStatus" <> "toStatus")
);

INSERT INTO "EquipmentLifecycleEvent" (
  "id",
  "fromStatus",
  "toStatus",
  "reason",
  "cost",
  "occurredAt",
  "createdAt",
  "equipmentId",
  "employeeId"
)
SELECT
  "id",
  NULL,
  "status",
  'Legacy equipment imported',
  0,
  "createdAt",
  "createdAt",
  "id",
  "employeeId"
FROM "Equipment";

CREATE INDEX "EquipmentLifecycleEvent_equipmentId_occurredAt_idx"
  ON "EquipmentLifecycleEvent"("equipmentId", "occurredAt");
CREATE INDEX "EquipmentLifecycleEvent_employeeId_idx"
  ON "EquipmentLifecycleEvent"("employeeId");

ALTER TABLE "EquipmentLifecycleEvent"
  ADD CONSTRAINT "EquipmentLifecycleEvent_equipmentId_fkey"
    FOREIGN KEY ("equipmentId") REFERENCES "Equipment"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "EquipmentLifecycleEvent_employeeId_fkey"
    FOREIGN KEY ("employeeId") REFERENCES "Employee"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "SystemSetting"
  ADD COLUMN "key" TEXT,
  ADD COLUMN "typedValue" JSONB,
  ADD COLUMN "valueType" "SettingValueType" NOT NULL DEFAULT 'STRING',
  ADD COLUMN "isPublic" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "isSystem" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "version" INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN "deletedAt" TIMESTAMP(3),
  ADD COLUMN "updatedById" TEXT;

UPDATE "SystemSetting"
SET
  "key" = 'legacy.' || lower(replace("id", '-', '')),
  "typedValue" = to_jsonb("value");

ALTER TABLE "SystemSetting"
  DROP COLUMN "value";

ALTER TABLE "SystemSetting"
  RENAME COLUMN "typedValue" TO "value";

ALTER TABLE "SystemSetting"
  ALTER COLUMN "key" SET NOT NULL,
  ALTER COLUMN "value" SET NOT NULL,
  ALTER COLUMN "valueType" DROP DEFAULT,
  ADD CONSTRAINT "SystemSetting_positive_version_check" CHECK ("version" > 0),
  ADD CONSTRAINT "SystemSetting_value_type_check"
    CHECK (
      ("valueType" = 'STRING' AND jsonb_typeof("value") = 'string')
      OR ("valueType" = 'NUMBER' AND jsonb_typeof("value") = 'number')
      OR ("valueType" = 'BOOLEAN' AND jsonb_typeof("value") = 'boolean')
      OR (
        "valueType" = 'JSON'
        AND jsonb_typeof("value") IN ('object', 'array', 'null')
      )
    );

CREATE UNIQUE INDEX "SystemSetting_key_key" ON "SystemSetting"("key");
CREATE INDEX "SystemSetting_deletedAt_key_idx" ON "SystemSetting"("deletedAt", "key");

ALTER TABLE "SystemSetting"
  ADD CONSTRAINT "SystemSetting_updatedById_fkey"
    FOREIGN KEY ("updatedById") REFERENCES "Employee"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "SystemSettingRevision" (
  "id" TEXT NOT NULL,
  "version" INTEGER NOT NULL,
  "value" JSONB NOT NULL,
  "valueType" "SettingValueType" NOT NULL,
  "description" TEXT,
  "isPublic" BOOLEAN NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "deletedAt" TIMESTAMP(3),
  "settingId" TEXT NOT NULL,
  "employeeId" TEXT,

  CONSTRAINT "SystemSettingRevision_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "SystemSettingRevision_positive_version_check" CHECK ("version" > 0)
);

INSERT INTO "SystemSettingRevision" (
  "id",
  "version",
  "value",
  "valueType",
  "description",
  "isPublic",
  "createdAt",
  "deletedAt",
  "settingId",
  "employeeId"
)
SELECT
  "id",
  "version",
  "value",
  "valueType",
  "description",
  "isPublic",
  "createdAt",
  NULL,
  "id",
  NULL
FROM "SystemSetting";

CREATE UNIQUE INDEX "SystemSettingRevision_settingId_version_key"
  ON "SystemSettingRevision"("settingId", "version");
CREATE INDEX "SystemSettingRevision_settingId_createdAt_idx"
  ON "SystemSettingRevision"("settingId", "createdAt");
CREATE INDEX "SystemSettingRevision_employeeId_idx"
  ON "SystemSettingRevision"("employeeId");

ALTER TABLE "SystemSettingRevision"
  ADD CONSTRAINT "SystemSettingRevision_settingId_fkey"
    FOREIGN KEY ("settingId") REFERENCES "SystemSetting"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "SystemSettingRevision_employeeId_fkey"
    FOREIGN KEY ("employeeId") REFERENCES "Employee"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;
