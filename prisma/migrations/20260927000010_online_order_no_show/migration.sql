ALTER TABLE "OnlineOrderRequest" ADD COLUMN "noShowAt" TIMESTAMP(3);

ALTER TABLE "OnlineOrderRequest"
  ADD CONSTRAINT "OnlineOrderRequest_noShowAt_check"
  CHECK (
    "noShowAt" IS NULL OR
    ("pickupAt" IS NOT NULL AND "status" = 'CANCELLED' AND "cancelledAt" IS NOT NULL)
  );
