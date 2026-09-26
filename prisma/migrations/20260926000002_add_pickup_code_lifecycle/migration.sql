ALTER TABLE "Invoice"
  ADD COLUMN "pickupCodeVersion" INTEGER,
  ADD COLUMN "pickupCodeIssuedAt" TIMESTAMP(3);

-- Existing invoices keep NULL so previously issued stateless codes remain valid
-- for their original 72-hour window. New invoices start at version zero.
ALTER TABLE "Invoice"
  ALTER COLUMN "pickupCodeVersion" SET DEFAULT 0;
