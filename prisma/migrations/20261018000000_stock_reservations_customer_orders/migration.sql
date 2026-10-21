BEGIN;

ALTER TABLE "InventoryItem"
  ADD COLUMN "reservedStock" DECIMAL(18,4) NOT NULL DEFAULT 0;
ALTER TABLE "OnlineOrderRequest" ADD COLUMN "customerId" TEXT;
ALTER TABLE "OnlineOrderRequest" ADD CONSTRAINT "OnlineOrderRequest_customerId_fkey"
  FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE INDEX "OnlineOrderRequest_customerId_createdAt_id_idx"
  ON "OnlineOrderRequest"("customerId", "createdAt", "id");

CREATE TABLE "InventoryReservation" (
  "orderItemId" TEXT NOT NULL,
  "inventoryItemId" TEXT NOT NULL,
  "quantity" DECIMAL(18,4) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "InventoryReservation_pkey" PRIMARY KEY ("orderItemId", "inventoryItemId"),
  CONSTRAINT "InventoryReservation_quantity_check" CHECK ("quantity" > 0),
  CONSTRAINT "InventoryReservation_orderItemId_fkey" FOREIGN KEY ("orderItemId")
    REFERENCES "OrderItem"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "InventoryReservation_inventoryItemId_fkey" FOREIGN KEY ("inventoryItemId")
    REFERENCES "InventoryItem"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE INDEX "InventoryReservation_inventoryItemId_idx" ON "InventoryReservation"("inventoryItemId");

-- Existing accepted pending lines keep their recipe snapshots, never current pricing.
INSERT INTO "InventoryReservation" ("orderItemId", "inventoryItemId", "quantity")
SELECT oi."id", recipe."inventoryItemId", recipe."quantityPerItem" * oi."quantity"
FROM "OrderItem" oi
JOIN "OrderSession" os ON os."id" = oi."orderSessionId" AND os."sessionStatus" <> 'CANCELLED'
JOIN "OnlineOrderRequest" request ON request."orderSessionId" = os."id" AND request."status" = 'ACCEPTED'
JOIN LATERAL (
  SELECT r."inventoryItemId", r."quantityPerItem"
  FROM "OrderItemRecipeIngredient" r
  WHERE r."orderItemId" = oi."id" AND oi."recipeSnapshottedAt" IS NOT NULL
  UNION ALL
  SELECT r."inventoryItemId", r."quantity"
  FROM "MenuItemIngredient" r
  WHERE r."menuItemId" = oi."menuItemId" AND oi."recipeSnapshottedAt" IS NULL
) recipe ON true
WHERE oi."serveStatus" = 'PENDING';

DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM "InventoryReservation" r
    JOIN "InventoryItem" i ON i."id" = r."inventoryItemId"
    JOIN "Unit" u ON u."id" = i."unitId"
    JOIN "InventoryCategory" c ON c."id" = i."categoryId"
    WHERE i."deletedAt" IS NOT NULL OR u."deletedAt" IS NOT NULL OR c."deletedAt" IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'Pending accepted orders reference inactive inventory. Resolve these orders before migration.';
  END IF;
  IF EXISTS (
    SELECT 1 FROM "InventoryItem" i
    JOIN (SELECT "inventoryItemId", SUM("quantity") AS quantity
      FROM "InventoryReservation" GROUP BY "inventoryItemId") r ON r."inventoryItemId" = i."id"
    WHERE i."stock" < r.quantity
  ) THEN
    RAISE EXCEPTION 'Insufficient stock for existing accepted orders. Reconcile stock or cancel orders before migration.';
  END IF;
END $$;

UPDATE "InventoryItem" i SET "reservedStock" = r.quantity
FROM (SELECT "inventoryItemId", SUM("quantity") AS quantity
  FROM "InventoryReservation" GROUP BY "inventoryItemId") r
WHERE i."id" = r."inventoryItemId";
ALTER TABLE "InventoryItem" ADD CONSTRAINT "InventoryItem_reservedStock_check"
  CHECK ("reservedStock" >= 0 AND "reservedStock" <= "stock");

COMMIT;
