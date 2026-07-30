import type { InventoryTxType } from '@prisma/client';
import type { Decimal } from '@prisma/client/runtime/library';

export interface InventoryMovementInput {
  inventoryItemId: string;
  type: InventoryTxType;
  quantity: Decimal;
  unitPrice: Decimal | null;
  totalAmount: Decimal | null;
  transactionDate: Date;
  note?: string | null;
}

export interface InventoryMovementResult {
  inventoryItemId: string;
  transactionId: string;
  type: InventoryTxType;
  quantity: Decimal;
  stockAfter: Decimal;
}

export type InventoryEventName =
  | 'inventory.item.created'
  | 'inventory.item.updated'
  | 'inventory.item.deleted'
  | 'inventory.stock.imported'
  | 'inventory.stock.exported';

export interface InventoryEventBase {
  eventId: string;
  occurredAt: string;
  inventoryItemIds: string[];
}

export interface InventoryItemChangedPayload extends InventoryEventBase {
  inventoryItemId: string;
}

export interface InventoryStockMovedPayload extends InventoryEventBase {
  type: InventoryTxType;
  movements: InventoryMovementResult[];
}

export interface InventoryEventPayloadMap {
  'inventory.item.created': InventoryItemChangedPayload;
  'inventory.item.updated': InventoryItemChangedPayload;
  'inventory.item.deleted': InventoryItemChangedPayload;
  'inventory.stock.imported': InventoryStockMovedPayload;
  'inventory.stock.exported': InventoryStockMovedPayload;
}

export type InventoryEventListener<TEventName extends InventoryEventName> = (
  payload: InventoryEventPayloadMap[TEventName],
) => void | Promise<void>;
