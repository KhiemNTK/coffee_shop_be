CREATE TYPE "BankStatementEntryDirection" AS ENUM ('CREDIT', 'DEBIT');
CREATE TYPE "BankStatementMatchStatus" AS ENUM (
  'UNMATCHED',
  'MATCHED',
  'MISMATCH',
  'IGNORED'
);

CREATE TABLE "BankStatementImport" (
  "id" TEXT NOT NULL,
  "sourceFileName" TEXT NOT NULL,
  "statementFrom" TIMESTAMP(3) NOT NULL,
  "statementTo" TIMESTAMP(3) NOT NULL,
  "checksum" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "fundId" TEXT NOT NULL,
  "importedById" TEXT NOT NULL,
  CONSTRAINT "BankStatementImport_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "BankStatementImport_period_check" CHECK (
    "statementFrom" < "statementTo"
  )
);

CREATE TABLE "BankStatementEntry" (
  "id" TEXT NOT NULL,
  "externalId" TEXT NOT NULL,
  "direction" "BankStatementEntryDirection" NOT NULL,
  "amount" DECIMAL(18,2) NOT NULL,
  "transactionDate" TIMESTAMP(3) NOT NULL,
  "bankReference" TEXT,
  "description" TEXT,
  "matchStatus" "BankStatementMatchStatus" NOT NULL DEFAULT 'UNMATCHED',
  "mismatchReason" TEXT,
  "matchedAt" TIMESTAMP(3),
  "ignoredAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  "importId" TEXT NOT NULL,
  "fundId" TEXT NOT NULL,
  "matchedHandoverId" TEXT,
  CONSTRAINT "BankStatementEntry_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "BankStatementEntry_amount_check" CHECK ("amount" > 0),
  CONSTRAINT "BankStatementEntry_state_check" CHECK (
    (
      "matchStatus" = 'UNMATCHED'
      AND "mismatchReason" IS NULL
      AND "matchedAt" IS NULL
      AND "ignoredAt" IS NULL
      AND "matchedHandoverId" IS NULL
    )
    OR
    (
      "matchStatus" = 'MATCHED'
      AND "mismatchReason" IS NULL
      AND "matchedAt" IS NOT NULL
      AND "ignoredAt" IS NULL
      AND "matchedHandoverId" IS NOT NULL
    )
    OR
    (
      "matchStatus" = 'MISMATCH'
      AND "mismatchReason" IS NOT NULL
      AND "matchedAt" IS NULL
      AND "ignoredAt" IS NULL
      AND "matchedHandoverId" IS NULL
    )
    OR
    (
      "matchStatus" = 'IGNORED'
      AND "mismatchReason" IS NOT NULL
      AND "matchedAt" IS NULL
      AND "ignoredAt" IS NOT NULL
      AND "matchedHandoverId" IS NULL
    )
  )
);

CREATE UNIQUE INDEX "BankStatementImport_fundId_checksum_key"
  ON "BankStatementImport"("fundId", "checksum");
CREATE INDEX "BankStatementImport_fundId_createdAt_idx"
  ON "BankStatementImport"("fundId", "createdAt");
CREATE INDEX "BankStatementImport_statementFrom_statementTo_idx"
  ON "BankStatementImport"("statementFrom", "statementTo");

CREATE UNIQUE INDEX "BankStatementEntry_matchedHandoverId_key"
  ON "BankStatementEntry"("matchedHandoverId");
CREATE UNIQUE INDEX "BankStatementEntry_fundId_externalId_key"
  ON "BankStatementEntry"("fundId", "externalId");
CREATE INDEX "BankStatementEntry_importId_transactionDate_idx"
  ON "BankStatementEntry"("importId", "transactionDate");
CREATE INDEX "BankStatementEntry_fundId_matchStatus_transactionDate_idx"
  ON "BankStatementEntry"("fundId", "matchStatus", "transactionDate");
CREATE INDEX "BankStatementEntry_matchStatus_transactionDate_idx"
  ON "BankStatementEntry"("matchStatus", "transactionDate");
CREATE INDEX "BankStatementEntry_fundId_bankReference_idx"
  ON "BankStatementEntry"("fundId", "bankReference");

ALTER TABLE "BankStatementImport"
  ADD CONSTRAINT "BankStatementImport_fundId_fkey"
    FOREIGN KEY ("fundId") REFERENCES "Fund"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "BankStatementImport_importedById_fkey"
    FOREIGN KEY ("importedById") REFERENCES "Employee"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "BankStatementEntry"
  ADD CONSTRAINT "BankStatementEntry_importId_fkey"
    FOREIGN KEY ("importId") REFERENCES "BankStatementImport"("id")
    ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "BankStatementEntry_fundId_fkey"
    FOREIGN KEY ("fundId") REFERENCES "Fund"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "BankStatementEntry_matchedHandoverId_fkey"
    FOREIGN KEY ("matchedHandoverId") REFERENCES "CashHandover"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

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
          AND (
            (
              "bankReference" IS NULL
              AND "evidenceReference" IS NULL
            )
            OR
            (
              "bankReference" IS NOT NULL
              AND "evidenceReference" IS NOT NULL
            )
          )
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
