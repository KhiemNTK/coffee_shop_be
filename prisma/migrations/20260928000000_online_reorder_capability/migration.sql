ALTER TABLE "OnlineOrderRequest"
  ADD COLUMN "reorderNonce" VARCHAR(64);

ALTER TABLE "OnlineOrderRequest"
  ADD CONSTRAINT "OnlineOrderRequest_reorderNonce_check"
  CHECK ("reorderNonce" IS NULL OR "reorderNonce" ~ '^[0-9a-f]{64}$');
