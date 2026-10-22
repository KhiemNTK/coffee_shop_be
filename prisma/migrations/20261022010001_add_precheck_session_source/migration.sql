ALTER TABLE "PrintJob" ADD COLUMN "orderSessionId" TEXT;

ALTER TABLE "PrintJob"
  ADD CONSTRAINT "PrintJob_orderSessionId_fkey"
  FOREIGN KEY ("orderSessionId") REFERENCES "OrderSession"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE INDEX "PrintJob_orderSessionId_createdAt_idx"
  ON "PrintJob" ("orderSessionId", "createdAt");

ALTER TABLE "PrintJob" DROP CONSTRAINT "PrintJob_source_check";
ALTER TABLE "PrintJob" ADD CONSTRAINT "PrintJob_source_check" CHECK (
  num_nonnulls("invoiceId", "kitchenTicketId", "orderSessionId") = 1
  AND (
    ("type" = 'RECEIPT' AND "invoiceId" IS NOT NULL)
    OR ("type" = 'KITCHEN_TICKET' AND "kitchenTicketId" IS NOT NULL)
    OR ("type" = 'PRECHECK' AND "orderSessionId" IS NOT NULL)
  )
) NOT VALID;
ALTER TABLE "PrintJob" VALIDATE CONSTRAINT "PrintJob_source_check";
