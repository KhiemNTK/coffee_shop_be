ALTER TABLE "OnlineOrderRequest"
  DROP CONSTRAINT "OnlineOrderRequest_state_check";

ALTER TABLE "OnlineOrderRequest"
  ADD CONSTRAINT "OnlineOrderRequest_state_check" CHECK (
    ("status" = 'PENDING' AND "reviewedAt" IS NULL AND "reviewedById" IS NULL AND "orderSessionId" IS NULL AND "rejectionReason" IS NULL AND "cancelledAt" IS NULL AND "cancellationReason" IS NULL)
    OR ("status" = 'ACCEPTED' AND "reviewedAt" IS NOT NULL AND "reviewedById" IS NOT NULL AND "orderSessionId" IS NOT NULL AND "rejectionReason" IS NULL AND "cancelledAt" IS NULL AND "cancellationReason" IS NULL)
    OR ("status" = 'REJECTED' AND "reviewedAt" IS NOT NULL AND "reviewedById" IS NOT NULL AND "orderSessionId" IS NULL AND "rejectionReason" IS NOT NULL AND LENGTH(BTRIM("rejectionReason")) >= 2 AND "cancelledAt" IS NULL AND "cancellationReason" IS NULL)
    OR ("status" = 'CANCELLED' AND "cancelledAt" IS NOT NULL AND "reviewedAt" IS NULL AND "reviewedById" IS NULL AND "orderSessionId" IS NULL AND "rejectionReason" IS NULL AND "cancellationReason" IS NULL)
    OR ("status" = 'CANCELLED' AND "cancelledAt" IS NOT NULL AND "reviewedAt" IS NOT NULL AND "reviewedById" IS NOT NULL AND "orderSessionId" IS NOT NULL AND "rejectionReason" IS NULL AND "cancellationReason" IS NOT NULL AND LENGTH(BTRIM("cancellationReason")) >= 2)
  );
