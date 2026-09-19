CREATE TYPE "FundType" AS ENUM ('CASH', 'BANK', 'OTHER');

ALTER TABLE "Fund"
  ADD COLUMN "type" "FundType" NOT NULL DEFAULT 'OTHER';

ALTER TABLE "Fund"
  ALTER COLUMN "type" DROP DEFAULT;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "Fund" WHERE "balance" < 0) THEN
    RAISE EXCEPTION 'Negative Fund balance detected.';
  END IF;
END $$;

ALTER TABLE "Fund"
  ADD CONSTRAINT "Fund_balance_non_negative_check" CHECK ("balance" >= 0);

ALTER TABLE "CashierShift"
  ADD COLUMN "closingNote" TEXT,
  ADD COLUMN "fundId" TEXT;

ALTER TABLE "CashTransaction"
  ADD COLUMN "invoiceId" TEXT;

ALTER TABLE "CashTransaction"
  ADD CONSTRAINT "CashTransaction_invoice_ledger_check" CHECK (
    "invoiceId" IS NULL OR ("type" = 'INCOME' AND "shiftId" IS NOT NULL)
  );

CREATE INDEX "Fund_deletedAt_type_idx"
  ON "Fund"("deletedAt", "type");

CREATE INDEX "CashierShift_employeeId_status_openedAt_idx"
  ON "CashierShift"("employeeId", "status", "openedAt");

CREATE INDEX "CashierShift_fundId_status_idx"
  ON "CashierShift"("fundId", "status");

CREATE INDEX "CashierShift_status_closedAt_idx"
  ON "CashierShift"("status", "closedAt");

CREATE UNIQUE INDEX "CashierShift_one_open_per_fund_idx"
  ON "CashierShift"("fundId")
  WHERE "status" = 'OPEN' AND "fundId" IS NOT NULL;

CREATE UNIQUE INDEX "CashTransaction_invoiceId_key"
  ON "CashTransaction"("invoiceId");

CREATE INDEX "CashTransaction_fundId_transactionDate_idx"
  ON "CashTransaction"("fundId", "transactionDate");

CREATE INDEX "CashTransaction_shiftId_transactionDate_idx"
  ON "CashTransaction"("shiftId", "transactionDate");

CREATE INDEX "CashTransaction_employeeId_transactionDate_idx"
  ON "CashTransaction"("employeeId", "transactionDate");

ALTER TABLE "CashierShift"
  ADD CONSTRAINT "CashierShift_fundId_fkey"
    FOREIGN KEY ("fundId") REFERENCES "Fund"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "CashTransaction"
  ADD CONSTRAINT "CashTransaction_invoiceId_fkey"
    FOREIGN KEY ("invoiceId") REFERENCES "Invoice"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;
