ALTER TABLE "PaymentAttempt"
  DROP CONSTRAINT "PaymentAttempt_state_check",
  ALTER COLUMN "status" DROP DEFAULT;

ALTER TYPE "PaymentAttemptStatus" RENAME TO "PaymentAttemptStatus_old";
CREATE TYPE "PaymentAttemptStatus" AS ENUM (
  'PENDING',
  'SUCCEEDED',
  'FAILED',
  'EXPIRED',
  'REQUIRES_REVIEW'
);

ALTER TABLE "PaymentAttempt"
  ALTER COLUMN "status" TYPE "PaymentAttemptStatus"
    USING ("status"::text::"PaymentAttemptStatus"),
  ALTER COLUMN "status" SET DEFAULT 'PENDING';

DROP TYPE "PaymentAttemptStatus_old";

CREATE TYPE "PaymentRefundType" AS ENUM ('FULL', 'PARTIAL');

CREATE TYPE "PaymentRefundStatus" AS ENUM (
  'PENDING',
  'PROCESSING',
  'SUCCEEDED',
  'FAILED',
  'REJECTED',
  'REQUIRES_REVIEW'
);

CREATE TYPE "PaymentProviderRequestType" AS ENUM ('QUERY', 'REFUND');
CREATE TYPE "PaymentProviderRequestStatus" AS ENUM (
  'PENDING',
  'SUCCEEDED',
  'FAILED'
);

CREATE TYPE "PaymentReconciliationIncidentType" AS ENUM (
  'STALE_ATTEMPT',
  'PAYMENT_STATE_CONFLICT',
  'PROVIDER_PAYMENT_MISMATCH',
  'REFUND_STATE_MISMATCH',
  'PROVIDER_UNAVAILABLE'
);

CREATE TYPE "PaymentReconciliationIncidentStatus" AS ENUM (
  'OPEN',
  'RESOLVED',
  'IGNORED'
);

ALTER TABLE "PaymentAttempt"
  ADD COLUMN "providerCreatedAt" TIMESTAMP(3),
  ADD COLUMN "lastReconciledAt" TIMESTAMP(3),
  ADD COLUMN "nextReconcileAt" TIMESTAMP(3),
  ADD COLUMN "reconciliationAttempts" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "reconciliationLockedAt" TIMESTAMP(3);

UPDATE "PaymentAttempt"
SET
  "providerCreatedAt" = "createdAt",
  "nextReconcileAt" = CASE
    WHEN "status" IN ('PENDING', 'EXPIRED') THEN "expiresAt"
    ELSE NULL
  END;

ALTER TABLE "PaymentAttempt"
  ALTER COLUMN "providerCreatedAt" SET NOT NULL,
  ALTER COLUMN "providerCreatedAt" SET DEFAULT CURRENT_TIMESTAMP,
  ADD CONSTRAINT "PaymentAttempt_reconciliationAttempts_check"
    CHECK ("reconciliationAttempts" >= 0);

ALTER TABLE "PaymentAttempt"
  ADD CONSTRAINT "PaymentAttempt_state_check" CHECK (
    (
      "status" = 'PENDING'
      AND "completedAt" IS NULL
      AND "providerTransactionNo" IS NULL
      AND "failureCode" IS NULL
    )
    OR
    (
      "status" = 'SUCCEEDED'
      AND "completedAt" IS NOT NULL
      AND "providerTransactionNo" IS NOT NULL
      AND "failureCode" IS NULL
    )
    OR
    (
      "status" = 'FAILED'
      AND "completedAt" IS NOT NULL
      AND "failureCode" IS NOT NULL
    )
    OR
    (
      "status" = 'EXPIRED'
      AND "completedAt" IS NOT NULL
      AND "providerTransactionNo" IS NULL
    )
    OR
    (
      "status" = 'REQUIRES_REVIEW'
      AND "completedAt" IS NULL
    )
  );

CREATE TABLE "PaymentRefund" (
  "id" TEXT NOT NULL,
  "type" "PaymentRefundType" NOT NULL,
  "status" "PaymentRefundStatus" NOT NULL DEFAULT 'PENDING',
  "amount" DECIMAL(18,2) NOT NULL,
  "reason" TEXT NOT NULL,
  "idempotencyKey" TEXT NOT NULL,
  "requestHash" TEXT NOT NULL,
  "providerRequestId" TEXT NOT NULL,
  "providerTransactionNo" TEXT,
  "providerResponseCode" TEXT,
  "providerTransactionStatus" TEXT,
  "providerMessage" TEXT,
  "lastError" TEXT,
  "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "completedAt" TIMESTAMP(3),
  "nextReconcileAt" TIMESTAMP(3),
  "reconciliationAttempts" INTEGER NOT NULL DEFAULT 0,
  "reconciliationLockedAt" TIMESTAMP(3),
  "updatedAt" TIMESTAMP(3) NOT NULL,
  "paymentAttemptId" TEXT NOT NULL,
  "requestedById" TEXT NOT NULL,
  CONSTRAINT "PaymentRefund_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "PaymentRefund_amount_check" CHECK ("amount" > 0),
  CONSTRAINT "PaymentRefund_reconciliationAttempts_check"
    CHECK ("reconciliationAttempts" >= 0),
  CONSTRAINT "PaymentRefund_completion_check" CHECK (
    (
      "status" IN ('SUCCEEDED', 'FAILED', 'REJECTED')
      AND "completedAt" IS NOT NULL
    )
    OR
    (
      "status" IN ('PENDING', 'PROCESSING', 'REQUIRES_REVIEW')
      AND "completedAt" IS NULL
    )
  )
);

CREATE TABLE "PaymentProviderRequest" (
  "id" TEXT NOT NULL,
  "requestId" TEXT NOT NULL,
  "type" "PaymentProviderRequestType" NOT NULL,
  "status" "PaymentProviderRequestStatus" NOT NULL DEFAULT 'PENDING',
  "requestPayload" JSONB NOT NULL,
  "responsePayload" JSONB,
  "responseCode" TEXT,
  "transactionStatus" TEXT,
  "errorMessage" TEXT,
  "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "completedAt" TIMESTAMP(3),
  "paymentAttemptId" TEXT NOT NULL,
  "paymentRefundId" TEXT,
  CONSTRAINT "PaymentProviderRequest_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "PaymentProviderRequest_completion_check" CHECK (
    ("status" = 'PENDING' AND "completedAt" IS NULL)
    OR
    ("status" IN ('SUCCEEDED', 'FAILED') AND "completedAt" IS NOT NULL)
  )
);

CREATE TABLE "PaymentReconciliationIncident" (
  "id" TEXT NOT NULL,
  "type" "PaymentReconciliationIncidentType" NOT NULL,
  "status" "PaymentReconciliationIncidentStatus" NOT NULL DEFAULT 'OPEN',
  "deduplicationKey" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "details" JSONB NOT NULL,
  "detectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "resolvedAt" TIMESTAMP(3),
  "resolutionNote" TEXT,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  "paymentAttemptId" TEXT NOT NULL,
  "paymentRefundId" TEXT,
  "resolvedById" TEXT,
  CONSTRAINT "PaymentReconciliationIncident_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "PaymentReconciliationIncident_resolution_check" CHECK (
    ("status" = 'OPEN' AND "resolvedAt" IS NULL)
    OR
    ("status" IN ('RESOLVED', 'IGNORED') AND "resolvedAt" IS NOT NULL)
  )
);

CREATE UNIQUE INDEX "PaymentRefund_providerRequestId_key"
  ON "PaymentRefund"("providerRequestId");
CREATE INDEX "PaymentRefund_providerTransactionNo_idx"
  ON "PaymentRefund"("providerTransactionNo");
CREATE UNIQUE INDEX "PaymentRefund_requestedById_idempotencyKey_key"
  ON "PaymentRefund"("requestedById", "idempotencyKey");
CREATE INDEX "PaymentRefund_paymentAttemptId_status_requestedAt_idx"
  ON "PaymentRefund"("paymentAttemptId", "status", "requestedAt");
CREATE INDEX "PaymentRefund_status_nextReconcileAt_idx"
  ON "PaymentRefund"("status", "nextReconcileAt");
CREATE INDEX "PaymentRefund_requestedById_requestedAt_idx"
  ON "PaymentRefund"("requestedById", "requestedAt");

CREATE UNIQUE INDEX "PaymentProviderRequest_requestId_key"
  ON "PaymentProviderRequest"("requestId");
CREATE INDEX "PaymentProviderRequest_paymentAttemptId_type_startedAt_idx"
  ON "PaymentProviderRequest"("paymentAttemptId", "type", "startedAt");
CREATE INDEX "PaymentProviderRequest_paymentRefundId_startedAt_idx"
  ON "PaymentProviderRequest"("paymentRefundId", "startedAt");
CREATE INDEX "PaymentProviderRequest_status_startedAt_idx"
  ON "PaymentProviderRequest"("status", "startedAt");

CREATE UNIQUE INDEX "PaymentReconciliationIncident_deduplicationKey_key"
  ON "PaymentReconciliationIncident"("deduplicationKey");
CREATE INDEX "PaymentReconciliationIncident_status_detectedAt_idx"
  ON "PaymentReconciliationIncident"("status", "detectedAt");
CREATE INDEX "PaymentReconciliationIncident_paymentAttemptId_status_idx"
  ON "PaymentReconciliationIncident"("paymentAttemptId", "status");
CREATE INDEX "PaymentReconciliationIncident_paymentRefundId_status_idx"
  ON "PaymentReconciliationIncident"("paymentRefundId", "status");
CREATE INDEX "PaymentAttempt_status_nextReconcileAt_idx"
  ON "PaymentAttempt"("status", "nextReconcileAt");

ALTER TABLE "PaymentRefund"
  ADD CONSTRAINT "PaymentRefund_paymentAttemptId_fkey"
  FOREIGN KEY ("paymentAttemptId") REFERENCES "PaymentAttempt"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "PaymentRefund_requestedById_fkey"
  FOREIGN KEY ("requestedById") REFERENCES "Employee"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "PaymentProviderRequest"
  ADD CONSTRAINT "PaymentProviderRequest_paymentAttemptId_fkey"
  FOREIGN KEY ("paymentAttemptId") REFERENCES "PaymentAttempt"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "PaymentProviderRequest_paymentRefundId_fkey"
  FOREIGN KEY ("paymentRefundId") REFERENCES "PaymentRefund"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "PaymentReconciliationIncident"
  ADD CONSTRAINT "PaymentReconciliationIncident_paymentAttemptId_fkey"
  FOREIGN KEY ("paymentAttemptId") REFERENCES "PaymentAttempt"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "PaymentReconciliationIncident_paymentRefundId_fkey"
  FOREIGN KEY ("paymentRefundId") REFERENCES "PaymentRefund"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "PaymentReconciliationIncident_resolvedById_fkey"
  FOREIGN KEY ("resolvedById") REFERENCES "Employee"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
