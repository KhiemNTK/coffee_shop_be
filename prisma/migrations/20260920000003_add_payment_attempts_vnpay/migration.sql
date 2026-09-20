ALTER TYPE "PaymentStatus" RENAME TO "PaymentStatus_old";

CREATE TYPE "PaymentStatus" AS ENUM (
  'UNPAID',
  'PAID',
  'VOIDED',
  'PARTIALLY_REFUNDED',
  'REFUNDED'
);

ALTER TABLE "Invoice"
  ALTER COLUMN "paymentStatus" DROP DEFAULT;

ALTER TABLE "Invoice"
  ALTER COLUMN "paymentStatus" TYPE "PaymentStatus"
  USING (
    CASE "paymentStatus"::text
      WHEN 'PENDING' THEN 'UNPAID'
      WHEN 'FAILED' THEN 'VOIDED'
      ELSE "paymentStatus"::text
    END
  )::"PaymentStatus";

ALTER TABLE "Invoice"
  ALTER COLUMN "paymentStatus" SET DEFAULT 'UNPAID';

DROP TYPE "PaymentStatus_old";

CREATE TYPE "PaymentProvider" AS ENUM ('VNPAY');
CREATE TYPE "PaymentAttemptStatus" AS ENUM (
  'PENDING',
  'SUCCEEDED',
  'FAILED',
  'EXPIRED'
);

CREATE TABLE "PaymentAttempt" (
  "id" TEXT NOT NULL,
  "provider" "PaymentProvider" NOT NULL DEFAULT 'VNPAY',
  "status" "PaymentAttemptStatus" NOT NULL DEFAULT 'PENDING',
  "amount" DECIMAL(18,2) NOT NULL,
  "currency" TEXT NOT NULL DEFAULT 'VND',
  "merchantReference" TEXT NOT NULL,
  "idempotencyKey" TEXT NOT NULL,
  "requestHash" TEXT NOT NULL,
  "providerTransactionNo" TEXT,
  "failureCode" TEXT,
  "closeSessionAfterPayment" BOOLEAN NOT NULL DEFAULT true,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "completedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  "invoiceId" TEXT NOT NULL,
  "createdById" TEXT NOT NULL,
  "shiftId" TEXT NOT NULL,
  CONSTRAINT "PaymentAttempt_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "PaymentAttempt_amount_check" CHECK ("amount" > 0),
  CONSTRAINT "PaymentAttempt_currency_check" CHECK ("currency" = 'VND'),
  CONSTRAINT "PaymentAttempt_expiry_check" CHECK ("expiresAt" > "createdAt"),
  CONSTRAINT "PaymentAttempt_state_check" CHECK (
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
  )
);

CREATE TABLE "PaymentWebhookEvent" (
  "id" TEXT NOT NULL,
  "provider" "PaymentProvider" NOT NULL,
  "payloadHash" TEXT NOT NULL,
  "merchantReference" TEXT,
  "providerTransactionNo" TEXT,
  "responseCode" TEXT,
  "transactionStatus" TEXT,
  "payload" JSONB NOT NULL,
  "processingCode" TEXT,
  "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "processedAt" TIMESTAMP(3),
  "paymentAttemptId" TEXT,
  CONSTRAINT "PaymentWebhookEvent_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "PaymentWebhookEvent_processing_check" CHECK (
    ("processingCode" IS NULL AND "processedAt" IS NULL)
    OR
    ("processingCode" IS NOT NULL AND "processedAt" IS NOT NULL)
  )
);

CREATE UNIQUE INDEX "PaymentAttempt_merchantReference_key"
  ON "PaymentAttempt"("merchantReference");
CREATE UNIQUE INDEX "PaymentAttempt_idempotencyKey_key"
  ON "PaymentAttempt"("idempotencyKey");
CREATE UNIQUE INDEX "PaymentAttempt_providerTransactionNo_key"
  ON "PaymentAttempt"("providerTransactionNo");
CREATE INDEX "PaymentAttempt_invoiceId_status_createdAt_idx"
  ON "PaymentAttempt"("invoiceId", "status", "createdAt");
CREATE INDEX "PaymentAttempt_status_expiresAt_idx"
  ON "PaymentAttempt"("status", "expiresAt");
CREATE INDEX "PaymentAttempt_createdById_createdAt_idx"
  ON "PaymentAttempt"("createdById", "createdAt");
CREATE INDEX "PaymentAttempt_shiftId_createdAt_idx"
  ON "PaymentAttempt"("shiftId", "createdAt");

CREATE UNIQUE INDEX "PaymentWebhookEvent_payloadHash_key"
  ON "PaymentWebhookEvent"("payloadHash");
CREATE INDEX "PaymentWebhookEvent_provider_receivedAt_idx"
  ON "PaymentWebhookEvent"("provider", "receivedAt");
CREATE INDEX "PaymentWebhookEvent_merchantReference_receivedAt_idx"
  ON "PaymentWebhookEvent"("merchantReference", "receivedAt");
CREATE INDEX "PaymentWebhookEvent_paymentAttemptId_receivedAt_idx"
  ON "PaymentWebhookEvent"("paymentAttemptId", "receivedAt");

ALTER TABLE "PaymentAttempt"
  ADD CONSTRAINT "PaymentAttempt_invoiceId_fkey"
    FOREIGN KEY ("invoiceId") REFERENCES "Invoice"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "PaymentAttempt_createdById_fkey"
    FOREIGN KEY ("createdById") REFERENCES "Employee"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "PaymentAttempt_shiftId_fkey"
    FOREIGN KEY ("shiftId") REFERENCES "CashierShift"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "PaymentWebhookEvent"
  ADD CONSTRAINT "PaymentWebhookEvent_paymentAttemptId_fkey"
    FOREIGN KEY ("paymentAttemptId") REFERENCES "PaymentAttempt"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;
