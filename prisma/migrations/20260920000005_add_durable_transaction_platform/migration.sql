CREATE TYPE "IdempotencyRequestStatus" AS ENUM ('PROCESSING', 'COMPLETED');
CREATE TYPE "OutboxEventStatus" AS ENUM (
  'PENDING',
  'PROCESSING',
  'PUBLISHED',
  'DEAD_LETTER'
);

CREATE TABLE "IdempotencyRequest" (
  "id" TEXT NOT NULL,
  "operation" TEXT NOT NULL,
  "key" TEXT NOT NULL,
  "requestHash" TEXT NOT NULL,
  "status" "IdempotencyRequestStatus" NOT NULL DEFAULT 'PROCESSING',
  "response" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  "completedAt" TIMESTAMP(3),
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "employeeId" TEXT NOT NULL,
  CONSTRAINT "IdempotencyRequest_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "IdempotencyRequest_state_check" CHECK (
    (
      "status" = 'PROCESSING'
      AND "response" IS NULL
      AND "completedAt" IS NULL
    )
    OR
    (
      "status" = 'COMPLETED'
      AND "response" IS NOT NULL
      AND "completedAt" IS NOT NULL
    )
  )
);

CREATE TABLE "OutboxEvent" (
  "id" TEXT NOT NULL,
  "topic" TEXT NOT NULL,
  "eventName" TEXT NOT NULL,
  "aggregateType" TEXT NOT NULL,
  "aggregateId" TEXT NOT NULL,
  "payload" JSONB NOT NULL,
  "status" "OutboxEventStatus" NOT NULL DEFAULT 'PENDING',
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "availableAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lockedAt" TIMESTAMP(3),
  "lockedBy" TEXT,
  "lastError" TEXT,
  "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "publishedAt" TIMESTAMP(3),
  CONSTRAINT "OutboxEvent_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "OutboxEvent_attempts_check" CHECK ("attempts" >= 0),
  CONSTRAINT "OutboxEvent_state_check" CHECK (
    (
      "status" IN ('PENDING', 'PROCESSING')
      AND "publishedAt" IS NULL
    )
    OR
    (
      "status" = 'PUBLISHED'
      AND "publishedAt" IS NOT NULL
    )
    OR
    (
      "status" = 'DEAD_LETTER'
      AND "publishedAt" IS NULL
      AND "lastError" IS NOT NULL
    )
  )
);

ALTER TABLE "ActionLog" ADD COLUMN "requestId" TEXT;

CREATE UNIQUE INDEX "IdempotencyRequest_employeeId_operation_key_key"
  ON "IdempotencyRequest"("employeeId", "operation", "key");
CREATE INDEX "IdempotencyRequest_expiresAt_idx"
  ON "IdempotencyRequest"("expiresAt");
CREATE INDEX "OutboxEvent_status_availableAt_occurredAt_idx"
  ON "OutboxEvent"("status", "availableAt", "occurredAt");
CREATE INDEX "OutboxEvent_aggregateType_aggregateId_occurredAt_idx"
  ON "OutboxEvent"("aggregateType", "aggregateId", "occurredAt");
CREATE INDEX "OutboxEvent_topic_eventName_occurredAt_idx"
  ON "OutboxEvent"("topic", "eventName", "occurredAt");
CREATE INDEX "ActionLog_requestId_idx" ON "ActionLog"("requestId");
CREATE INDEX "ActionLog_employeeId_createdAt_idx"
  ON "ActionLog"("employeeId", "createdAt");

ALTER TABLE "IdempotencyRequest"
  ADD CONSTRAINT "IdempotencyRequest_employeeId_fkey"
  FOREIGN KEY ("employeeId") REFERENCES "Employee"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE OR REPLACE FUNCTION prevent_action_log_mutation()
RETURNS TRIGGER AS $$
BEGIN
  IF current_setting('app.allow_audit_log_mutation', true) = 'on' THEN
    IF TG_OP = 'DELETE' THEN
      RETURN OLD;
    END IF;
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'ActionLog is append-only';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "ActionLog_immutable_update_delete"
BEFORE UPDATE OR DELETE ON "ActionLog"
FOR EACH ROW EXECUTE FUNCTION prevent_action_log_mutation();
