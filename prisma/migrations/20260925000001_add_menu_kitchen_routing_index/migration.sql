CREATE INDEX "MenuItem_kitchenStationId_deletedAt_isAvailable_idx"
  ON "MenuItem"("kitchenStationId", "deletedAt", "isAvailable");
