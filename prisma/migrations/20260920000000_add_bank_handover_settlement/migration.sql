CREATE TYPE "CashHandoverSettlementStatus" AS ENUM (
  'NOT_REQUIRED',
  'PENDING',
  'SETTLED'
);

ALTER TABLE "CashHandover"
  ADD COLUMN "settlementStatus" "CashHandoverSettlementStatus" NOT NULL DEFAULT 'NOT_REQUIRED',
  ADD COLUMN "settlementDueAt" TIMESTAMP(3),
  ADD COLUMN "settledAt" TIMESTAMP(3),
  ADD COLUMN "bankReference" TEXT,
  ADD COLUMN "evidenceReference" TEXT,
  ADD COLUMN "settledById" TEXT;

UPDATE "CashHandover" handover
SET
  "settlementStatus" = 'SETTLED',
  "settlementDueAt" = handover."resolvedAt",
  "settledAt" = handover."resolvedAt",
  "bankReference" = 'LEGACY-' || handover."id",
  "evidenceReference" = 'legacy:migrated',
  "settledById" = handover."resolvedById"
FROM "Fund" destination
WHERE handover."destinationFundId" = destination."id"
  AND handover."status" = 'APPROVED'
  AND destination."type" = 'BANK';

ALTER TABLE "CashHandover"
  DROP CONSTRAINT "CashHandover_state_check";

ALTER TABLE "CashHandover"
  ADD CONSTRAINT "CashHandover_state_check" CHECK (
    (
      "status" = 'PENDING'
      AND "resolvedAt" IS NULL
      AND "resolvedById" IS NULL
      AND "sourceTransactionId" IS NULL
      AND "destinationTransactionId" IS NULL
      AND "varianceTransactionId" IS NULL
      AND "settlementStatus" = 'NOT_REQUIRED'
      AND "settlementDueAt" IS NULL
      AND "settledAt" IS NULL
      AND "settledById" IS NULL
      AND "bankReference" IS NULL
      AND "evidenceReference" IS NULL
    )
    OR
    (
      "status" = 'APPROVED'
      AND "resolvedAt" IS NOT NULL
      AND "resolvedById" IS NOT NULL
      AND "sourceTransactionId" IS NOT NULL
      AND (
        ("varianceAmount" = 0 AND "varianceTransactionId" IS NULL)
        OR
        ("varianceAmount" <> 0 AND "varianceTransactionId" IS NOT NULL)
      )
      AND (
        (
          "settlementStatus" = 'NOT_REQUIRED'
          AND "destinationTransactionId" IS NOT NULL
          AND "settlementDueAt" IS NULL
          AND "settledAt" IS NULL
          AND "settledById" IS NULL
          AND "bankReference" IS NULL
          AND "evidenceReference" IS NULL
        )
        OR
        (
          "settlementStatus" = 'PENDING'
          AND "destinationTransactionId" IS NULL
          AND "settlementDueAt" IS NOT NULL
          AND "settledAt" IS NULL
          AND "settledById" IS NULL
          AND "bankReference" IS NULL
          AND "evidenceReference" IS NULL
        )
        OR
        (
          "settlementStatus" = 'SETTLED'
          AND "destinationTransactionId" IS NOT NULL
          AND "settlementDueAt" IS NOT NULL
          AND "settledAt" IS NOT NULL
          AND "settledById" IS NOT NULL
          AND "bankReference" IS NOT NULL
          AND "evidenceReference" IS NOT NULL
        )
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
      AND "settlementStatus" = 'NOT_REQUIRED'
      AND "settlementDueAt" IS NULL
      AND "settledAt" IS NULL
      AND "settledById" IS NULL
      AND "bankReference" IS NULL
      AND "evidenceReference" IS NULL
    )
    OR
    (
      "status" = 'CANCELLED'
      AND "resolvedAt" IS NOT NULL
      AND "resolvedById" IS NOT NULL
      AND "sourceTransactionId" IS NULL
      AND "destinationTransactionId" IS NULL
      AND "varianceTransactionId" IS NULL
      AND "settlementStatus" = 'NOT_REQUIRED'
      AND "settlementDueAt" IS NULL
      AND "settledAt" IS NULL
      AND "settledById" IS NULL
      AND "bankReference" IS NULL
      AND "evidenceReference" IS NULL
    )
  );

CREATE UNIQUE INDEX "CashHandover_destinationFundId_bankReference_key"
  ON "CashHandover"("destinationFundId", "bankReference");

CREATE INDEX "CashHandover_settlementStatus_settlementDueAt_idx"
  ON "CashHandover"("settlementStatus", "settlementDueAt");

ALTER TABLE "CashHandover"
  ADD CONSTRAINT "CashHandover_settledById_fkey"
    FOREIGN KEY ("settledById") REFERENCES "Employee"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;
