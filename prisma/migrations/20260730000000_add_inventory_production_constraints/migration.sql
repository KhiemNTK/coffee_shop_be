-- Inventory production constraints and indexes.
-- Preflight: resolve any duplicate active names before applying this migration.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "InventoryCategory"
    WHERE "deletedAt" IS NULL
    GROUP BY lower("name")
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'Duplicate active InventoryCategory.name values detected.';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "Unit"
    WHERE "deletedAt" IS NULL
    GROUP BY lower("name")
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'Duplicate active Unit.name values detected.';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "InventoryItem"
    WHERE "deletedAt" IS NULL
    GROUP BY "categoryId", lower("name")
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'Duplicate active InventoryItem.name values detected in the same category.';
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "Unit_deletedAt_idx"
  ON "Unit" ("deletedAt");
CREATE INDEX IF NOT EXISTS "Unit_name_idx"
  ON "Unit" ("name");
CREATE UNIQUE INDEX IF NOT EXISTS "Unit_active_name_lower_unique_idx"
  ON "Unit" (lower("name"))
  WHERE "deletedAt" IS NULL;

CREATE INDEX IF NOT EXISTS "InventoryCategory_deletedAt_idx"
  ON "InventoryCategory" ("deletedAt");
CREATE INDEX IF NOT EXISTS "InventoryCategory_name_idx"
  ON "InventoryCategory" ("name");
CREATE UNIQUE INDEX IF NOT EXISTS "InventoryCategory_active_name_lower_unique_idx"
  ON "InventoryCategory" (lower("name"))
  WHERE "deletedAt" IS NULL;

CREATE INDEX IF NOT EXISTS "InventoryItem_categoryId_idx"
  ON "InventoryItem" ("categoryId");
CREATE INDEX IF NOT EXISTS "InventoryItem_unitId_idx"
  ON "InventoryItem" ("unitId");
CREATE INDEX IF NOT EXISTS "InventoryItem_deletedAt_idx"
  ON "InventoryItem" ("deletedAt");
CREATE INDEX IF NOT EXISTS "InventoryItem_name_idx"
  ON "InventoryItem" ("name");
CREATE INDEX IF NOT EXISTS "InventoryItem_stock_idx"
  ON "InventoryItem" ("stock");
CREATE UNIQUE INDEX IF NOT EXISTS "InventoryItem_active_category_name_lower_unique_idx"
  ON "InventoryItem" ("categoryId", lower("name"))
  WHERE "deletedAt" IS NULL;

CREATE INDEX IF NOT EXISTS "InventoryTransaction_inventoryItemId_idx"
  ON "InventoryTransaction" ("inventoryItemId");
CREATE INDEX IF NOT EXISTS "InventoryTransaction_type_transactionDate_idx"
  ON "InventoryTransaction" ("type", "transactionDate");
CREATE INDEX IF NOT EXISTS "InventoryTransaction_transactionDate_idx"
  ON "InventoryTransaction" ("transactionDate");
CREATE INDEX IF NOT EXISTS "InventoryTransaction_inventoryItemId_transactionDate_idx"
  ON "InventoryTransaction" ("inventoryItemId", "transactionDate");

DO $$
BEGIN
  ALTER TABLE "InventoryItem"
    ADD CONSTRAINT "InventoryItem_stock_non_negative_check"
    CHECK ("stock" >= 0);
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER TABLE "InventoryTransaction"
    ADD CONSTRAINT "InventoryTransaction_quantity_positive_check"
    CHECK ("quantity" > 0);
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER TABLE "InventoryTransaction"
    ADD CONSTRAINT "InventoryTransaction_unit_price_non_negative_check"
    CHECK ("unitPrice" IS NULL OR "unitPrice" >= 0);
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER TABLE "InventoryTransaction"
    ADD CONSTRAINT "InventoryTransaction_total_amount_non_negative_check"
    CHECK ("totalAmount" IS NULL OR "totalAmount" >= 0);
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;
