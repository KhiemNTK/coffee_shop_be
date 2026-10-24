ALTER TABLE "OnlineOrderRequest"
  DROP CONSTRAINT "OnlineOrderRequest_noShowAt_check",
  ADD CONSTRAINT "OnlineOrderRequest_noShowAt_check"
  CHECK (
    "noShowAt" IS NULL OR
    ("status" = 'CANCELLED' AND "cancelledAt" IS NOT NULL)
  );
