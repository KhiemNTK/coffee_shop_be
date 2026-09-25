CREATE TYPE "PurchaseReceiptStatus" AS ENUM ('DRAFT', 'POSTED', 'CANCELLED');
CREATE TYPE "StocktakeStatus" AS ENUM ('DRAFT', 'POSTED', 'CANCELLED');

ALTER TABLE "InventoryItem"
  ADD COLUMN "averageUnitCost" DECIMAL(18, 2) NOT NULL DEFAULT 0,
  ADD COLUMN "reorderPoint" DECIMAL(18, 4) NOT NULL DEFAULT 0;

-- Legacy movements did not persist moving-average snapshots. Bootstrap the
-- current carrying cost from the latest priced import without fabricating
-- historical COGS for old exports.
UPDATE "InventoryItem" item
SET "averageUnitCost" = latest."unitPrice"
FROM (
  SELECT DISTINCT ON (movement."inventoryItemId")
    movement."inventoryItemId",
    movement."unitPrice"
  FROM "InventoryTransaction" movement
  WHERE movement."type" = 'IMPORT'
    AND movement."unitPrice" IS NOT NULL
  ORDER BY
    movement."inventoryItemId",
    movement."transactionDate" DESC,
    movement."createdAt" DESC,
    movement."id" DESC
) latest
WHERE latest."inventoryItemId" = item."id";

ALTER TABLE "OrderItemIngredientSnapshot"
  ADD COLUMN "unitCost" DECIMAL(18, 2) NOT NULL DEFAULT 0,
  ADD COLUMN "totalCost" DECIMAL(18, 2) NOT NULL DEFAULT 0;

CREATE TABLE "Supplier" (
  "id" TEXT NOT NULL,
  "code" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "contactName" TEXT,
  "phoneNumber" TEXT,
  "email" TEXT,
  "address" TEXT,
  "taxCode" TEXT,
  "notes" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  "deletedAt" TIMESTAMP(3),

  CONSTRAINT "Supplier_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "PurchaseReceipt" (
  "id" TEXT NOT NULL,
  "receiptNumber" TEXT NOT NULL,
  "status" "PurchaseReceiptStatus" NOT NULL DEFAULT 'DRAFT',
  "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "totalAmount" DECIMAL(18, 2) NOT NULL DEFAULT 0,
  "note" TEXT,
  "postedAt" TIMESTAMP(3),
  "cancelledAt" TIMESTAMP(3),
  "cancellationReason" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  "supplierId" TEXT NOT NULL,
  "createdById" TEXT NOT NULL,
  "postedById" TEXT,
  "cancelledById" TEXT,

  CONSTRAINT "PurchaseReceipt_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "PurchaseReceipt_total_non_negative_check"
    CHECK ("totalAmount" >= 0),
  CONSTRAINT "PurchaseReceipt_state_check" CHECK (
    (
      "status" = 'DRAFT'
      AND "postedAt" IS NULL
      AND "postedById" IS NULL
      AND "cancelledAt" IS NULL
      AND "cancelledById" IS NULL
      AND "cancellationReason" IS NULL
    )
    OR (
      "status" = 'POSTED'
      AND "postedAt" IS NOT NULL
      AND "postedById" IS NOT NULL
      AND "cancelledAt" IS NULL
      AND "cancelledById" IS NULL
      AND "cancellationReason" IS NULL
    )
    OR (
      "status" = 'CANCELLED'
      AND "postedAt" IS NULL
      AND "postedById" IS NULL
      AND "cancelledAt" IS NOT NULL
      AND "cancelledById" IS NOT NULL
      AND length(trim("cancellationReason")) > 0
    )
  )
);

CREATE TABLE "PurchaseReceiptItem" (
  "id" TEXT NOT NULL,
  "inventoryItemName" TEXT NOT NULL,
  "unitName" TEXT NOT NULL,
  "quantity" DECIMAL(18, 4) NOT NULL,
  "unitPrice" DECIMAL(18, 2) NOT NULL,
  "totalAmount" DECIMAL(18, 2) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "purchaseReceiptId" TEXT NOT NULL,
  "inventoryItemId" TEXT NOT NULL,

  CONSTRAINT "PurchaseReceiptItem_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "PurchaseReceiptItem_values_check" CHECK (
    "quantity" > 0
    AND "unitPrice" >= 0
    AND "totalAmount" = round("quantity" * "unitPrice", 2)
  )
);

CREATE TABLE "Stocktake" (
  "id" TEXT NOT NULL,
  "stocktakeNumber" TEXT NOT NULL,
  "status" "StocktakeStatus" NOT NULL DEFAULT 'DRAFT',
  "note" TEXT,
  "postedAt" TIMESTAMP(3),
  "cancelledAt" TIMESTAMP(3),
  "cancellationReason" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  "createdById" TEXT NOT NULL,
  "postedById" TEXT,
  "cancelledById" TEXT,

  CONSTRAINT "Stocktake_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "Stocktake_state_check" CHECK (
    (
      "status" = 'DRAFT'
      AND "postedAt" IS NULL
      AND "postedById" IS NULL
      AND "cancelledAt" IS NULL
      AND "cancelledById" IS NULL
      AND "cancellationReason" IS NULL
    )
    OR (
      "status" = 'POSTED'
      AND "postedAt" IS NOT NULL
      AND "postedById" IS NOT NULL
      AND "cancelledAt" IS NULL
      AND "cancelledById" IS NULL
      AND "cancellationReason" IS NULL
    )
    OR (
      "status" = 'CANCELLED'
      AND "postedAt" IS NULL
      AND "postedById" IS NULL
      AND "cancelledAt" IS NOT NULL
      AND "cancelledById" IS NOT NULL
      AND length(trim("cancellationReason")) > 0
    )
  )
);

CREATE TABLE "StocktakeItem" (
  "id" TEXT NOT NULL,
  "inventoryItemName" TEXT NOT NULL,
  "unitName" TEXT NOT NULL,
  "expectedQuantity" DECIMAL(18, 4) NOT NULL,
  "countedQuantity" DECIMAL(18, 4),
  "differenceQuantity" DECIMAL(18, 4),
  "countedAt" TIMESTAMP(3),
  "stocktakeId" TEXT NOT NULL,
  "inventoryItemId" TEXT NOT NULL,

  CONSTRAINT "StocktakeItem_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "StocktakeItem_count_check" CHECK (
    "expectedQuantity" >= 0
    AND ("countedQuantity" IS NULL OR "countedQuantity" >= 0)
    AND (
      ("countedQuantity" IS NULL AND "countedAt" IS NULL)
      OR ("countedQuantity" IS NOT NULL AND "countedAt" IS NOT NULL)
    )
    AND (
      "differenceQuantity" IS NULL
      OR "differenceQuantity" = "countedQuantity" - "expectedQuantity"
    )
  )
);

ALTER TABLE "InventoryTransaction"
  ADD COLUMN "purchaseReceiptItemId" TEXT,
  ADD COLUMN "stocktakeItemId" TEXT;

ALTER TABLE "InventoryItem"
  ADD CONSTRAINT "InventoryItem_costing_non_negative_check"
    CHECK ("averageUnitCost" >= 0 AND "reorderPoint" >= 0);

ALTER TABLE "OrderItemIngredientSnapshot"
  ADD CONSTRAINT "OrderItemIngredientSnapshot_cost_non_negative_check"
    CHECK ("unitCost" >= 0 AND "totalCost" >= 0);

ALTER TABLE "InventoryTransaction"
  ADD CONSTRAINT "InventoryTransaction_single_source_check"
    CHECK (num_nonnulls("orderItemId", "purchaseReceiptItemId", "stocktakeItemId") <= 1);

CREATE UNIQUE INDEX "Supplier_active_code_upper_unique_idx"
  ON "Supplier"(upper("code"))
  WHERE "deletedAt" IS NULL;
CREATE INDEX "Supplier_deletedAt_name_idx" ON "Supplier"("deletedAt", "name");
CREATE INDEX "Supplier_name_idx" ON "Supplier"("name");

CREATE UNIQUE INDEX "PurchaseReceipt_receiptNumber_key"
  ON "PurchaseReceipt"("receiptNumber");
CREATE INDEX "PurchaseReceipt_status_receivedAt_idx"
  ON "PurchaseReceipt"("status", "receivedAt");
CREATE INDEX "PurchaseReceipt_supplierId_status_idx"
  ON "PurchaseReceipt"("supplierId", "status");
CREATE INDEX "PurchaseReceipt_createdById_createdAt_idx"
  ON "PurchaseReceipt"("createdById", "createdAt");

CREATE UNIQUE INDEX "PurchaseReceiptItem_purchaseReceiptId_inventoryItemId_key"
  ON "PurchaseReceiptItem"("purchaseReceiptId", "inventoryItemId");
CREATE INDEX "PurchaseReceiptItem_inventoryItemId_idx"
  ON "PurchaseReceiptItem"("inventoryItemId");

CREATE UNIQUE INDEX "Stocktake_stocktakeNumber_key"
  ON "Stocktake"("stocktakeNumber");
CREATE INDEX "Stocktake_status_createdAt_idx"
  ON "Stocktake"("status", "createdAt");
CREATE INDEX "Stocktake_createdById_createdAt_idx"
  ON "Stocktake"("createdById", "createdAt");

CREATE UNIQUE INDEX "StocktakeItem_stocktakeId_inventoryItemId_key"
  ON "StocktakeItem"("stocktakeId", "inventoryItemId");
CREATE INDEX "StocktakeItem_inventoryItemId_idx"
  ON "StocktakeItem"("inventoryItemId");

CREATE UNIQUE INDEX "InventoryTransaction_purchaseReceiptItemId_key"
  ON "InventoryTransaction"("purchaseReceiptItemId");
CREATE UNIQUE INDEX "InventoryTransaction_stocktakeItemId_key"
  ON "InventoryTransaction"("stocktakeItemId");
CREATE INDEX "InventoryItem_reorderPoint_stock_idx"
  ON "InventoryItem"("reorderPoint", "stock")
  WHERE "deletedAt" IS NULL AND "reorderPoint" > 0;

ALTER TABLE "PurchaseReceipt"
  ADD CONSTRAINT "PurchaseReceipt_supplierId_fkey"
    FOREIGN KEY ("supplierId") REFERENCES "Supplier"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "PurchaseReceipt_createdById_fkey"
    FOREIGN KEY ("createdById") REFERENCES "Employee"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "PurchaseReceipt_postedById_fkey"
    FOREIGN KEY ("postedById") REFERENCES "Employee"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "PurchaseReceipt_cancelledById_fkey"
    FOREIGN KEY ("cancelledById") REFERENCES "Employee"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "PurchaseReceiptItem"
  ADD CONSTRAINT "PurchaseReceiptItem_purchaseReceiptId_fkey"
    FOREIGN KEY ("purchaseReceiptId") REFERENCES "PurchaseReceipt"("id")
    ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "PurchaseReceiptItem_inventoryItemId_fkey"
    FOREIGN KEY ("inventoryItemId") REFERENCES "InventoryItem"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "Stocktake"
  ADD CONSTRAINT "Stocktake_createdById_fkey"
    FOREIGN KEY ("createdById") REFERENCES "Employee"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "Stocktake_postedById_fkey"
    FOREIGN KEY ("postedById") REFERENCES "Employee"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "Stocktake_cancelledById_fkey"
    FOREIGN KEY ("cancelledById") REFERENCES "Employee"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "StocktakeItem"
  ADD CONSTRAINT "StocktakeItem_stocktakeId_fkey"
    FOREIGN KEY ("stocktakeId") REFERENCES "Stocktake"("id")
    ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "StocktakeItem_inventoryItemId_fkey"
    FOREIGN KEY ("inventoryItemId") REFERENCES "InventoryItem"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "InventoryTransaction"
  ADD CONSTRAINT "InventoryTransaction_purchaseReceiptItemId_fkey"
    FOREIGN KEY ("purchaseReceiptItemId") REFERENCES "PurchaseReceiptItem"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "InventoryTransaction_stocktakeItemId_fkey"
    FOREIGN KEY ("stocktakeItemId") REFERENCES "StocktakeItem"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;
