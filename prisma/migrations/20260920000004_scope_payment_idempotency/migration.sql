DROP INDEX "PaymentAttempt_idempotencyKey_key";

CREATE UNIQUE INDEX "PaymentAttempt_createdById_idempotencyKey_key"
  ON "PaymentAttempt"("createdById", "idempotencyKey");
