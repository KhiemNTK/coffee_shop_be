-- NULL preserves immediate release for historical tickets without rewriting SLA history.
ALTER TABLE "KitchenTicket" ADD COLUMN "availableAt" TIMESTAMP(3);
CREATE INDEX "KitchenTicket_availableAt_stationId_idx" ON "KitchenTicket"("availableAt", "stationId");
