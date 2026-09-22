DROP INDEX "PaymentRefund_status_nextReconcileAt_idx";

ALTER TABLE "PaymentRefund"
  DROP CONSTRAINT "PaymentRefund_reconciliationAttempts_check",
  DROP COLUMN "nextReconcileAt",
  DROP COLUMN "reconciliationAttempts";

CREATE INDEX "PaymentRefund_status_requestedAt_idx"
  ON "PaymentRefund"("status", "requestedAt");
