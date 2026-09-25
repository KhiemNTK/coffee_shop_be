export const INVENTORY_EVENTS = {
  ITEM_CREATED: 'inventory.item.created',
  ITEM_UPDATED: 'inventory.item.updated',
  ITEM_DELETED: 'inventory.item.deleted',
  STOCK_IMPORTED: 'inventory.stock.imported',
  STOCK_EXPORTED: 'inventory.stock.exported',
  PURCHASE_RECEIPT_POSTED: 'inventory.purchase-receipt.posted',
  STOCKTAKE_POSTED: 'inventory.stocktake.posted',
} as const;
