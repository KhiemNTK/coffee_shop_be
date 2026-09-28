ALTER TABLE "OnlineOrderRequest" ADD COLUMN "pickupAt" TIMESTAMP(3);

ALTER TABLE "OnlineOrderRequest"
  ADD CONSTRAINT "OnlineOrderRequest_pickupAt_check"
  CHECK ("pickupAt" IS NULL OR "pickupAt" > "createdAt");

CREATE INDEX "OnlineOrderRequest_status_pickupAt_id_idx"
  ON "OnlineOrderRequest"("status", "pickupAt", "id");
