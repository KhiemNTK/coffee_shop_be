BEGIN;

CREATE TABLE "CashRefund" (
  "id" TEXT NOT NULL,
  "amount" DECIMAL(18,2) NOT NULL,
  "reason" VARCHAR(500) NOT NULL,
  "idempotencyKey" VARCHAR(120) NOT NULL,
  "requestHash" VARCHAR(64) NOT NULL,
  "completedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "invoiceId" TEXT NOT NULL,
  "requestedById" TEXT NOT NULL,
  "cashTransactionId" TEXT NOT NULL,
  CONSTRAINT "CashRefund_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "CashRefund_positive_amount" CHECK ("amount" > 0),
  CONSTRAINT "CashRefund_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "Invoice"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "CashRefund_requestedById_fkey" FOREIGN KEY ("requestedById") REFERENCES "Employee"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "CashRefund_cashTransactionId_fkey" FOREIGN KEY ("cashTransactionId") REFERENCES "CashTransaction"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "CashRefund_cashTransactionId_key" ON "CashRefund"("cashTransactionId");
CREATE UNIQUE INDEX "CashRefund_requestedById_idempotencyKey_key" ON "CashRefund"("requestedById", "idempotencyKey");
CREATE INDEX "CashRefund_invoiceId_completedAt_idx" ON "CashRefund"("invoiceId", "completedAt");
CREATE INDEX "CashRefund_completedAt_idx" ON "CashRefund"("completedAt");

CREATE TABLE "OrderRemake" (
  "id" TEXT NOT NULL,
  "reason" VARCHAR(500) NOT NULL,
  "idempotencyKey" VARCHAR(120) NOT NULL,
  "requestHash" VARCHAR(64) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "originalItemId" TEXT NOT NULL,
  "replacementItemId" TEXT NOT NULL,
  "requestedById" TEXT NOT NULL,
  CONSTRAINT "OrderRemake_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "OrderRemake_distinct_items" CHECK ("originalItemId" <> "replacementItemId"),
  CONSTRAINT "OrderRemake_originalItemId_fkey" FOREIGN KEY ("originalItemId") REFERENCES "OrderItem"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "OrderRemake_replacementItemId_fkey" FOREIGN KEY ("replacementItemId") REFERENCES "OrderItem"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "OrderRemake_requestedById_fkey" FOREIGN KEY ("requestedById") REFERENCES "Employee"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "OrderRemake_originalItemId_key" ON "OrderRemake"("originalItemId");
CREATE UNIQUE INDEX "OrderRemake_replacementItemId_key" ON "OrderRemake"("replacementItemId");
CREATE UNIQUE INDEX "OrderRemake_requestedById_idempotencyKey_key" ON "OrderRemake"("requestedById", "idempotencyKey");
CREATE INDEX "OrderRemake_createdAt_idx" ON "OrderRemake"("createdAt");

COMMIT;
