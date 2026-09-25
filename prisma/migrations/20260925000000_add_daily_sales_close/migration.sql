CREATE TABLE "DailySalesClose" (
  "id" TEXT NOT NULL,
  "businessDate" DATE NOT NULL,
  "timeZone" TEXT NOT NULL DEFAULT 'Asia/Ho_Chi_Minh',
  "periodStart" TIMESTAMP(3) NOT NULL,
  "periodEnd" TIMESTAMP(3) NOT NULL,
  "closedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "snapshot" JSONB NOT NULL,
  "closedById" TEXT NOT NULL,

  CONSTRAINT "DailySalesClose_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "DailySalesClose_valid_period_check" CHECK (
    "periodStart" < "periodEnd"
    AND "closedAt" >= "periodEnd"
    AND "timeZone" = 'Asia/Ho_Chi_Minh'
    AND jsonb_typeof("snapshot") = 'object'
  )
);

CREATE UNIQUE INDEX "DailySalesClose_businessDate_key"
  ON "DailySalesClose"("businessDate");
CREATE INDEX "DailySalesClose_closedAt_idx"
  ON "DailySalesClose"("closedAt");

ALTER TABLE "DailySalesClose"
  ADD CONSTRAINT "DailySalesClose_closedById_fkey"
    FOREIGN KEY ("closedById") REFERENCES "Employee"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE FUNCTION reject_daily_sales_close_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'DailySalesClose is immutable' USING ERRCODE = '23514';
END;
$$;

CREATE TRIGGER "DailySalesClose_immutable_trigger"
  BEFORE UPDATE OR DELETE ON "DailySalesClose"
  FOR EACH ROW EXECUTE FUNCTION reject_daily_sales_close_mutation();
