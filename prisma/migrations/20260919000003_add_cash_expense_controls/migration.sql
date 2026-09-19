CREATE TYPE "CashExpenseRequestStatus" AS ENUM (
  'PENDING',
  'APPROVED',
  'REJECTED',
  'CANCELLED'
);

ALTER TABLE "CashierShift"
  ADD COLUMN "expectedStartingCash" DECIMAL(18, 2),
  ADD COLUMN "openingDifference" DECIMAL(18, 2);

UPDATE "CashierShift"
SET
  "expectedStartingCash" = "startingCash",
  "openingDifference" = 0;

ALTER TABLE "CashierShift"
  ALTER COLUMN "expectedStartingCash" SET NOT NULL,
  ALTER COLUMN "expectedStartingCash" SET DEFAULT 0,
  ALTER COLUMN "openingDifference" SET NOT NULL,
  ALTER COLUMN "openingDifference" SET DEFAULT 0;

ALTER TABLE "CashierShift"
  ADD CONSTRAINT "CashierShift_opening_cash_check" CHECK (
    "expectedStartingCash" >= 0
    AND "openingDifference" = "startingCash" - "expectedStartingCash"
  );

CREATE TABLE "CashExpenseRequest" (
  "id" TEXT NOT NULL,
  "amount" DECIMAL(18, 2) NOT NULL,
  "description" TEXT NOT NULL,
  "status" "CashExpenseRequestStatus" NOT NULL DEFAULT 'PENDING',
  "resolutionNote" TEXT,
  "resolvedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  "requestedById" TEXT NOT NULL,
  "resolvedById" TEXT,
  "shiftId" TEXT NOT NULL,
  "fundId" TEXT NOT NULL,
  "cashTransactionId" TEXT,

  CONSTRAINT "CashExpenseRequest_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "CashExpenseRequest_amount_positive_check" CHECK ("amount" > 0),
  CONSTRAINT "CashExpenseRequest_state_check" CHECK (
    (
      "status" = 'PENDING'
      AND "resolvedAt" IS NULL
      AND "resolvedById" IS NULL
      AND "cashTransactionId" IS NULL
    )
    OR
    (
      "status" = 'APPROVED'
      AND "resolvedAt" IS NOT NULL
      AND "resolvedById" IS NOT NULL
      AND "cashTransactionId" IS NOT NULL
    )
    OR
    (
      "status" IN ('REJECTED', 'CANCELLED')
      AND "resolvedAt" IS NOT NULL
      AND "resolvedById" IS NOT NULL
      AND "cashTransactionId" IS NULL
    )
  )
);

CREATE UNIQUE INDEX "CashExpenseRequest_cashTransactionId_key"
  ON "CashExpenseRequest"("cashTransactionId");

CREATE INDEX "CashExpenseRequest_status_createdAt_idx"
  ON "CashExpenseRequest"("status", "createdAt");

CREATE INDEX "CashExpenseRequest_shiftId_status_idx"
  ON "CashExpenseRequest"("shiftId", "status");

CREATE INDEX "CashExpenseRequest_requestedById_status_idx"
  ON "CashExpenseRequest"("requestedById", "status");

ALTER TABLE "CashExpenseRequest"
  ADD CONSTRAINT "CashExpenseRequest_requestedById_fkey"
    FOREIGN KEY ("requestedById") REFERENCES "Employee"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "CashExpenseRequest_resolvedById_fkey"
    FOREIGN KEY ("resolvedById") REFERENCES "Employee"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "CashExpenseRequest_shiftId_fkey"
    FOREIGN KEY ("shiftId") REFERENCES "CashierShift"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "CashExpenseRequest_fundId_fkey"
    FOREIGN KEY ("fundId") REFERENCES "Fund"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "CashExpenseRequest_cashTransactionId_fkey"
    FOREIGN KEY ("cashTransactionId") REFERENCES "CashTransaction"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;
