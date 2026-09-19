CREATE TYPE "CashHandoverStatus" AS ENUM (
  'PENDING',
  'APPROVED',
  'REJECTED',
  'CANCELLED'
);

CREATE TABLE "CashHandover" (
  "id" TEXT NOT NULL,
  "expectedCash" DECIMAL(18, 2) NOT NULL,
  "countedCash" DECIMAL(18, 2) NOT NULL,
  "varianceAmount" DECIMAL(18, 2) NOT NULL,
  "retainedCash" DECIMAL(18, 2) NOT NULL,
  "transferAmount" DECIMAL(18, 2) NOT NULL,
  "note" TEXT,
  "status" "CashHandoverStatus" NOT NULL DEFAULT 'PENDING',
  "resolutionNote" TEXT,
  "resolvedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  "requestedById" TEXT NOT NULL,
  "resolvedById" TEXT,
  "shiftId" TEXT NOT NULL,
  "sourceFundId" TEXT NOT NULL,
  "destinationFundId" TEXT NOT NULL,
  "sourceTransactionId" TEXT,
  "destinationTransactionId" TEXT,
  "varianceTransactionId" TEXT,

  CONSTRAINT "CashHandover_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "CashHandover_amounts_check" CHECK (
    "expectedCash" >= 0
    AND "countedCash" >= 0
    AND "retainedCash" >= 0
    AND "varianceAmount" = "countedCash" - "expectedCash"
    AND "transferAmount" = "countedCash" - "retainedCash"
    AND "transferAmount" > 0
  ),
  CONSTRAINT "CashHandover_distinct_funds_check" CHECK (
    "sourceFundId" <> "destinationFundId"
  ),
  CONSTRAINT "CashHandover_state_check" CHECK (
    (
      "status" = 'PENDING'
      AND "resolvedAt" IS NULL
      AND "resolvedById" IS NULL
      AND "sourceTransactionId" IS NULL
      AND "destinationTransactionId" IS NULL
      AND "varianceTransactionId" IS NULL
    )
    OR
    (
      "status" = 'APPROVED'
      AND "resolvedAt" IS NOT NULL
      AND "resolvedById" IS NOT NULL
      AND "sourceTransactionId" IS NOT NULL
      AND "destinationTransactionId" IS NOT NULL
      AND (
        ("varianceAmount" = 0 AND "varianceTransactionId" IS NULL)
        OR
        ("varianceAmount" <> 0 AND "varianceTransactionId" IS NOT NULL)
      )
    )
    OR
    (
      "status" = 'REJECTED'
      AND "resolvedAt" IS NOT NULL
      AND "resolvedById" IS NOT NULL
      AND "resolutionNote" IS NOT NULL
      AND "sourceTransactionId" IS NULL
      AND "destinationTransactionId" IS NULL
      AND "varianceTransactionId" IS NULL
    )
    OR
    (
      "status" = 'CANCELLED'
      AND "resolvedAt" IS NOT NULL
      AND "resolvedById" IS NOT NULL
      AND "sourceTransactionId" IS NULL
      AND "destinationTransactionId" IS NULL
      AND "varianceTransactionId" IS NULL
    )
  )
);

CREATE UNIQUE INDEX "CashHandover_sourceTransactionId_key"
  ON "CashHandover"("sourceTransactionId");

CREATE UNIQUE INDEX "CashHandover_destinationTransactionId_key"
  ON "CashHandover"("destinationTransactionId");

CREATE UNIQUE INDEX "CashHandover_varianceTransactionId_key"
  ON "CashHandover"("varianceTransactionId");

CREATE UNIQUE INDEX "CashHandover_active_shift_key"
  ON "CashHandover"("shiftId")
  WHERE "status" IN ('PENDING', 'APPROVED');

CREATE INDEX "CashHandover_status_createdAt_idx"
  ON "CashHandover"("status", "createdAt");

CREATE INDEX "CashHandover_shiftId_status_idx"
  ON "CashHandover"("shiftId", "status");

CREATE INDEX "CashHandover_sourceFundId_createdAt_idx"
  ON "CashHandover"("sourceFundId", "createdAt");

CREATE INDEX "CashHandover_destinationFundId_createdAt_idx"
  ON "CashHandover"("destinationFundId", "createdAt");

CREATE INDEX "CashHandover_requestedById_status_idx"
  ON "CashHandover"("requestedById", "status");

ALTER TABLE "CashHandover"
  ADD CONSTRAINT "CashHandover_requestedById_fkey"
    FOREIGN KEY ("requestedById") REFERENCES "Employee"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "CashHandover_resolvedById_fkey"
    FOREIGN KEY ("resolvedById") REFERENCES "Employee"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "CashHandover_shiftId_fkey"
    FOREIGN KEY ("shiftId") REFERENCES "CashierShift"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "CashHandover_sourceFundId_fkey"
    FOREIGN KEY ("sourceFundId") REFERENCES "Fund"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "CashHandover_destinationFundId_fkey"
    FOREIGN KEY ("destinationFundId") REFERENCES "Fund"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "CashHandover_sourceTransactionId_fkey"
    FOREIGN KEY ("sourceTransactionId") REFERENCES "CashTransaction"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "CashHandover_destinationTransactionId_fkey"
    FOREIGN KEY ("destinationTransactionId") REFERENCES "CashTransaction"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "CashHandover_varianceTransactionId_fkey"
    FOREIGN KEY ("varianceTransactionId") REFERENCES "CashTransaction"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;
