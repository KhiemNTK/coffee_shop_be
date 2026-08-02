-- Promotion production constraints and indexes.
-- Preflight: resolve duplicate active names before applying this migration.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "Promotion"
    WHERE "deletedAt" IS NULL
    GROUP BY lower("name")
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'Duplicate active Promotion.name values detected.';
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "Promotion_deletedAt_idx"
  ON "Promotion" ("deletedAt");
CREATE INDEX IF NOT EXISTS "Promotion_startDate_endDate_idx"
  ON "Promotion" ("startDate", "endDate");
CREATE INDEX IF NOT EXISTS "Promotion_discountType_idx"
  ON "Promotion" ("discountType");
CREATE INDEX IF NOT EXISTS "Promotion_createdAt_idx"
  ON "Promotion" ("createdAt");
CREATE INDEX IF NOT EXISTS "Promotion_name_idx"
  ON "Promotion" ("name");

CREATE UNIQUE INDEX IF NOT EXISTS "Promotion_active_name_lower_unique_idx"
  ON "Promotion" (lower("name"))
  WHERE "deletedAt" IS NULL;

DO $$
BEGIN
  ALTER TABLE "Promotion"
    ADD CONSTRAINT "Promotion_date_range_valid_check"
    CHECK ("startDate" < "endDate");
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER TABLE "Promotion"
    ADD CONSTRAINT "Promotion_discount_value_positive_check"
    CHECK ("discountValue" > 0);
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER TABLE "Promotion"
    ADD CONSTRAINT "Promotion_max_discount_positive_check"
    CHECK ("maxDiscount" IS NULL OR "maxDiscount" > 0);
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER TABLE "Promotion"
    ADD CONSTRAINT "Promotion_percentage_value_valid_check"
    CHECK (
      "discountType" <> 'PERCENTAGE'
      OR ("discountValue" > 0 AND "discountValue" <= 100)
    );
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;
