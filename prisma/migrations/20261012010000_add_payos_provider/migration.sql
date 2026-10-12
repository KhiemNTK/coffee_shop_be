ALTER TYPE "PaymentProvider" ADD VALUE 'PAYOS';

ALTER TABLE "PaymentAttempt" ADD COLUMN "providerPaymentLinkId" VARCHAR(32);
CREATE UNIQUE INDEX "PaymentAttempt_provider_providerPaymentLinkId_key"
  ON "PaymentAttempt"("provider", "providerPaymentLinkId");

CREATE SEQUENCE "payos_order_code_seq" AS BIGINT
  MINVALUE 1000000000 MAXVALUE 9007199254740991 START WITH 1000000000 NO CYCLE;
