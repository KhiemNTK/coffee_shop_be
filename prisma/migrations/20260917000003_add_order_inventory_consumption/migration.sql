-- Idempotent inventory consumption and waste history for prepared order items.

ALTER TABLE "InventoryTransaction"
  ADD COLUMN "orderItemId" TEXT;

CREATE TABLE "OrderItemIngredientSnapshot" (
  "orderItemId" TEXT NOT NULL,
  "inventoryItemId" TEXT NOT NULL,
  "inventoryItemName" TEXT NOT NULL,
  "unitName" TEXT NOT NULL,
  "quantityPerItem" DECIMAL(18,4) NOT NULL,
  "totalQuantity" DECIMAL(18,4) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "OrderItemIngredientSnapshot_pkey"
    PRIMARY KEY ("orderItemId", "inventoryItemId")
);

CREATE TABLE "InventoryWaste" (
  "id" TEXT NOT NULL,
  "orderItemId" TEXT NOT NULL,
  "inventoryItemId" TEXT NOT NULL,
  "quantity" DECIMAL(18,4) NOT NULL,
  "reason" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "employeeId" TEXT NOT NULL,

  CONSTRAINT "InventoryWaste_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "InventoryTransaction_orderItemId_inventoryItemId_key"
  ON "InventoryTransaction" ("orderItemId", "inventoryItemId");

CREATE INDEX "OrderItemIngredientSnapshot_inventoryItemId_idx"
  ON "OrderItemIngredientSnapshot" ("inventoryItemId");

CREATE UNIQUE INDEX "InventoryWaste_orderItemId_inventoryItemId_key"
  ON "InventoryWaste" ("orderItemId", "inventoryItemId");

CREATE INDEX "InventoryWaste_inventoryItemId_createdAt_idx"
  ON "InventoryWaste" ("inventoryItemId", "createdAt");

CREATE INDEX "InventoryWaste_employeeId_idx"
  ON "InventoryWaste" ("employeeId");

CREATE INDEX "InventoryWaste_createdAt_idx"
  ON "InventoryWaste" ("createdAt");

ALTER TABLE "InventoryTransaction"
  ADD CONSTRAINT "InventoryTransaction_orderItemId_fkey"
  FOREIGN KEY ("orderItemId") REFERENCES "OrderItem"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "OrderItemIngredientSnapshot"
  ADD CONSTRAINT "OrderItemIngredientSnapshot_orderItemId_fkey"
  FOREIGN KEY ("orderItemId") REFERENCES "OrderItem"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "OrderItemIngredientSnapshot"
  ADD CONSTRAINT "OrderItemIngredientSnapshot_inventoryItemId_fkey"
  FOREIGN KEY ("inventoryItemId") REFERENCES "InventoryItem"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "InventoryWaste"
  ADD CONSTRAINT "InventoryWaste_employeeId_fkey"
  FOREIGN KEY ("employeeId") REFERENCES "Employee"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "InventoryWaste"
  ADD CONSTRAINT "InventoryWaste_orderItemId_inventoryItemId_fkey"
  FOREIGN KEY ("orderItemId", "inventoryItemId")
  REFERENCES "OrderItemIngredientSnapshot"("orderItemId", "inventoryItemId")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "OrderItemIngredientSnapshot"
  ADD CONSTRAINT "OrderItemIngredientSnapshot_quantityPerItem_positive_check"
  CHECK ("quantityPerItem" > 0);

ALTER TABLE "OrderItemIngredientSnapshot"
  ADD CONSTRAINT "OrderItemIngredientSnapshot_totalQuantity_positive_check"
  CHECK ("totalQuantity" > 0);

ALTER TABLE "InventoryWaste"
  ADD CONSTRAINT "InventoryWaste_quantity_positive_check"
  CHECK ("quantity" > 0);
