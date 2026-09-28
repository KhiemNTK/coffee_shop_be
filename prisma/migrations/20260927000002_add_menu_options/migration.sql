CREATE TABLE "MenuItemOptionGroup" (
  "id" TEXT NOT NULL,
  "menuItemId" TEXT NOT NULL,
  "name" VARCHAR(80) NOT NULL,
  "minSelected" INTEGER NOT NULL DEFAULT 0,
  "maxSelected" INTEGER NOT NULL DEFAULT 1,
  "sortOrder" INTEGER NOT NULL DEFAULT 0,
  CONSTRAINT "MenuItemOptionGroup_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "MenuItemOptionGroup_selection_check" CHECK (
    "minSelected" >= 0 AND "maxSelected" BETWEEN 1 AND 20 AND "minSelected" <= "maxSelected"
  ),
  CONSTRAINT "MenuItemOptionGroup_sortOrder_check" CHECK ("sortOrder" >= 0)
);

CREATE TABLE "MenuItemOption" (
  "id" TEXT NOT NULL,
  "groupId" TEXT NOT NULL,
  "name" VARCHAR(80) NOT NULL,
  "priceDelta" DECIMAL(18,2) NOT NULL,
  "sortOrder" INTEGER NOT NULL DEFAULT 0,
  CONSTRAINT "MenuItemOption_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "MenuItemOption_priceDelta_check" CHECK ("priceDelta" >= 0),
  CONSTRAINT "MenuItemOption_sortOrder_check" CHECK ("sortOrder" >= 0)
);

CREATE TABLE "MenuItemOptionIngredient" (
  "optionId" TEXT NOT NULL,
  "inventoryItemId" TEXT NOT NULL,
  "quantity" DECIMAL(18,4) NOT NULL,
  CONSTRAINT "MenuItemOptionIngredient_pkey" PRIMARY KEY ("optionId", "inventoryItemId"),
  CONSTRAINT "MenuItemOptionIngredient_quantity_check" CHECK ("quantity" > 0)
);

CREATE TABLE "OrderItemRecipeIngredient" (
  "orderItemId" TEXT NOT NULL,
  "inventoryItemId" TEXT NOT NULL,
  "quantityPerItem" DECIMAL(18,4) NOT NULL,
  CONSTRAINT "OrderItemRecipeIngredient_pkey" PRIMARY KEY ("orderItemId", "inventoryItemId"),
  CONSTRAINT "OrderItemRecipeIngredient_quantity_check" CHECK ("quantityPerItem" > 0)
);

ALTER TABLE "OnlineOrderRequestItem"
  ADD COLUMN "quotedOptions" JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD CONSTRAINT "OnlineOrderRequestItem_quotedOptions_check" CHECK (jsonb_typeof("quotedOptions") = 'array');

ALTER TABLE "OrderItem"
  ADD COLUMN "selectedOptions" JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN "recipeSnapshottedAt" TIMESTAMP(3),
  ADD CONSTRAINT "OrderItem_selectedOptions_check" CHECK (jsonb_typeof("selectedOptions") = 'array');

ALTER TABLE "KitchenTicketItem"
  ADD COLUMN "selectedOptions" JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD CONSTRAINT "KitchenTicketItem_selectedOptions_check" CHECK (jsonb_typeof("selectedOptions") = 'array');

CREATE UNIQUE INDEX "MenuItemOptionGroup_menuItemId_name_key" ON "MenuItemOptionGroup"("menuItemId", "name");
CREATE INDEX "MenuItemOptionGroup_menuItemId_sortOrder_idx" ON "MenuItemOptionGroup"("menuItemId", "sortOrder");
CREATE UNIQUE INDEX "MenuItemOption_groupId_name_key" ON "MenuItemOption"("groupId", "name");
CREATE INDEX "MenuItemOption_groupId_sortOrder_idx" ON "MenuItemOption"("groupId", "sortOrder");
CREATE INDEX "MenuItemOptionIngredient_inventoryItemId_idx" ON "MenuItemOptionIngredient"("inventoryItemId");
CREATE INDEX "OrderItemRecipeIngredient_inventoryItemId_idx" ON "OrderItemRecipeIngredient"("inventoryItemId");

ALTER TABLE "MenuItemOptionGroup" ADD CONSTRAINT "MenuItemOptionGroup_menuItemId_fkey"
  FOREIGN KEY ("menuItemId") REFERENCES "MenuItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "MenuItemOption" ADD CONSTRAINT "MenuItemOption_groupId_fkey"
  FOREIGN KEY ("groupId") REFERENCES "MenuItemOptionGroup"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "MenuItemOptionIngredient" ADD CONSTRAINT "MenuItemOptionIngredient_optionId_fkey"
  FOREIGN KEY ("optionId") REFERENCES "MenuItemOption"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "MenuItemOptionIngredient" ADD CONSTRAINT "MenuItemOptionIngredient_inventoryItemId_fkey"
  FOREIGN KEY ("inventoryItemId") REFERENCES "InventoryItem"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "OrderItemRecipeIngredient" ADD CONSTRAINT "OrderItemRecipeIngredient_orderItemId_fkey"
  FOREIGN KEY ("orderItemId") REFERENCES "OrderItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "OrderItemRecipeIngredient" ADD CONSTRAINT "OrderItemRecipeIngredient_inventoryItemId_fkey"
  FOREIGN KEY ("inventoryItemId") REFERENCES "InventoryItem"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
