ALTER TYPE "PrintJobStatus" ADD VALUE 'REQUIRES_REVIEW';

ALTER TABLE "PrintJob" DROP CONSTRAINT "PrintJob_state_check";
ALTER TABLE "PrintJob" ADD CONSTRAINT "PrintJob_state_check" CHECK (
  ("status"::text = 'PENDING'
    AND "lockedAt" IS NULL AND "leaseExpiresAt" IS NULL AND "leaseTokenHash" IS NULL
    AND "printedAt" IS NULL AND "failedAt" IS NULL)
  OR ("status"::text = 'PROCESSING' AND "deviceId" IS NOT NULL
    AND "lockedAt" IS NOT NULL AND "leaseExpiresAt" IS NOT NULL AND "leaseTokenHash" IS NOT NULL
    AND "printedAt" IS NULL AND "failedAt" IS NULL)
  OR ("status"::text = 'REQUIRES_REVIEW'
    AND "lockedAt" IS NULL AND "leaseExpiresAt" IS NULL
    AND "printedAt" IS NULL AND "failedAt" IS NULL)
  OR ("status"::text = 'PRINTED' AND "deviceId" IS NOT NULL
    AND "lockedAt" IS NULL AND "leaseExpiresAt" IS NULL
    AND "printedAt" IS NOT NULL AND "failedAt" IS NULL)
  OR ("status"::text = 'FAILED'
    AND "lockedAt" IS NULL AND "leaseExpiresAt" IS NULL AND "leaseTokenHash" IS NULL
    AND "printedAt" IS NULL AND "failedAt" IS NOT NULL)
  OR ("status"::text = 'CANCELLED'
    AND "lockedAt" IS NULL AND "leaseExpiresAt" IS NULL AND "leaseTokenHash" IS NULL
    AND "printedAt" IS NULL AND "failedAt" IS NULL)
);
