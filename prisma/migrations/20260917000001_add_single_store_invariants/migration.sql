-- Single-store identity and cashier-shift invariants.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "Position"
    WHERE "deletedAt" IS NULL
    GROUP BY lower(btrim("name"))
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'Duplicate active Position.name values detected.';
  END IF;

  IF EXISTS (
    SELECT 1 FROM "DiningTable"
    WHERE "deletedAt" IS NULL
    GROUP BY lower(btrim("name"))
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'Duplicate active DiningTable.name values detected.';
  END IF;

  IF EXISTS (
    SELECT 1 FROM "Fund"
    WHERE "deletedAt" IS NULL
    GROUP BY lower(btrim("name"))
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'Duplicate active Fund.name values detected.';
  END IF;

  IF EXISTS (
    SELECT 1 FROM "MenuCategory"
    WHERE "deletedAt" IS NULL
    GROUP BY lower(btrim("name"))
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'Duplicate active MenuCategory.name values detected.';
  END IF;

  IF EXISTS (
    SELECT 1 FROM "MenuItem"
    WHERE "deletedAt" IS NULL
    GROUP BY "categoryId", lower(btrim("name"))
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'Duplicate active MenuItem.name values detected in the same category.';
  END IF;

  IF EXISTS (
    SELECT 1 FROM "CashierShift"
    WHERE "status" = 'OPEN'
    GROUP BY "employeeId"
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'Employees with multiple OPEN cashier shifts detected.';
  END IF;

  IF EXISTS (
    SELECT 1 FROM "CashierShift"
    WHERE NOT (
      ("status" = 'OPEN'
        AND "closedAt" IS NULL
        AND "reportedEndingCash" IS NULL
        AND "actualEndingCash" IS NULL)
      OR
      ("status" = 'CLOSED'
        AND "closedAt" IS NOT NULL
        AND "reportedEndingCash" IS NOT NULL
        AND "actualEndingCash" IS NOT NULL
        AND "closedAt" >= "openedAt")
    )
  ) THEN
    RAISE EXCEPTION 'Inconsistent CashierShift state detected.';
  END IF;
END $$;

CREATE UNIQUE INDEX "Position_active_name_unique_idx"
  ON "Position" (lower(btrim("name")))
  WHERE "deletedAt" IS NULL;

CREATE UNIQUE INDEX "DiningTable_active_name_unique_idx"
  ON "DiningTable" (lower(btrim("name")))
  WHERE "deletedAt" IS NULL;

CREATE UNIQUE INDEX "Fund_active_name_unique_idx"
  ON "Fund" (lower(btrim("name")))
  WHERE "deletedAt" IS NULL;

CREATE UNIQUE INDEX "MenuCategory_active_name_unique_idx"
  ON "MenuCategory" (lower(btrim("name")))
  WHERE "deletedAt" IS NULL;

CREATE UNIQUE INDEX "MenuItem_active_category_name_unique_idx"
  ON "MenuItem" ("categoryId", lower(btrim("name")))
  WHERE "deletedAt" IS NULL;

CREATE UNIQUE INDEX "CashierShift_one_open_per_employee_idx"
  ON "CashierShift" ("employeeId")
  WHERE "status" = 'OPEN';

ALTER TABLE "CashierShift"
  ADD CONSTRAINT "CashierShift_state_consistency_check" CHECK (
    ("status" = 'OPEN'
      AND "closedAt" IS NULL
      AND "reportedEndingCash" IS NULL
      AND "actualEndingCash" IS NULL)
    OR
    ("status" = 'CLOSED'
      AND "closedAt" IS NOT NULL
      AND "reportedEndingCash" IS NOT NULL
      AND "actualEndingCash" IS NOT NULL
      AND "closedAt" >= "openedAt")
  );
