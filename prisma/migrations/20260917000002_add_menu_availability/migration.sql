-- Menu availability and read-path indexes.

ALTER TABLE "MenuItem"
  ADD COLUMN "isAvailable" BOOLEAN NOT NULL DEFAULT true;

CREATE INDEX "MenuCategory_deletedAt_name_idx"
  ON "MenuCategory" ("deletedAt", "name");

CREATE INDEX "MenuItem_deletedAt_categoryId_isAvailable_idx"
  ON "MenuItem" ("deletedAt", "categoryId", "isAvailable");

CREATE INDEX "MenuItemIngredient_inventoryItemId_idx"
  ON "MenuItemIngredient" ("inventoryItemId");
