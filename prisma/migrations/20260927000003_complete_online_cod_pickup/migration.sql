ALTER TABLE "OnlineOrderRequest"
  ADD COLUMN "cancellationReason" VARCHAR(200);

CREATE INDEX "OnlineOrderRequest_status_createdAt_id_idx"
  ON "OnlineOrderRequest"("status", "createdAt", "id");
