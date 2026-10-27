ALTER TABLE "OutboxEvent"
  ADD COLUMN "lastErrorCode" TEXT,
  ADD COLUMN "lastFailedAt" TIMESTAMP(3);

CREATE INDEX "PrintJob_status_updatedAt_id_idx" ON "PrintJob"("status", "updatedAt", "id");
