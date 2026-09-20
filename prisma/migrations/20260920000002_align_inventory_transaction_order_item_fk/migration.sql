ALTER TABLE "InventoryTransaction"
  DROP CONSTRAINT "InventoryTransaction_orderItemId_fkey";

ALTER TABLE "InventoryTransaction"
  ADD CONSTRAINT "InventoryTransaction_orderItemId_fkey"
    FOREIGN KEY ("orderItemId") REFERENCES "OrderItem"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;
