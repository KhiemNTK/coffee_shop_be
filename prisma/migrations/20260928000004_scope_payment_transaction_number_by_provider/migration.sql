DROP INDEX "PaymentAttempt_providerTransactionNo_key";

CREATE UNIQUE INDEX "PaymentAttempt_provider_providerTransactionNo_key"
  ON "PaymentAttempt"("provider", "providerTransactionNo");
