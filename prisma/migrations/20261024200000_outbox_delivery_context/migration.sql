BEGIN;

ALTER TYPE "OutboxEventStatus" ADD VALUE 'ENQUEUED' BEFORE 'PROCESSING';
ALTER TABLE "OutboxEvent" ADD COLUMN "context" JSONB;

ALTER TABLE "OutboxEvent" DROP CONSTRAINT "OutboxEvent_state_check";
-- Text comparison permits adding the enum value and constraint atomically.
ALTER TABLE "OutboxEvent" ADD CONSTRAINT "OutboxEvent_state_check" CHECK (
  ("status"::text IN ('PENDING', 'ENQUEUED', 'PROCESSING') AND "publishedAt" IS NULL)
  OR ("status"::text = 'PUBLISHED' AND "publishedAt" IS NOT NULL)
  OR ("status"::text = 'DEAD_LETTER' AND "publishedAt" IS NULL AND "lastError" IS NOT NULL)
);

COMMIT;
