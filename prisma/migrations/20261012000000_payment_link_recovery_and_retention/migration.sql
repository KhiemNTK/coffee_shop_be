ALTER TABLE "PaymentAttempt" ADD COLUMN "paymentUrl" TEXT;

CREATE INDEX "OutboxEvent_status_publishedAt_idx" ON "OutboxEvent"("status", "publishedAt");
