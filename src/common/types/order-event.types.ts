import type { ServeStatus } from '@prisma/client';

export type OrderEventName =
  | 'order.session.opened'
  | 'order.items.added'
  | 'order.item.status.updated'
  | 'order.session.cancelled'
  | 'order.session.table.transferred'
  | 'order.sessions.merged'
  | 'order.session.split'
  | 'order.table.cleared'
  | 'order.invoice.created'
  | 'order.invoice.paid'
  | 'order.invoice.voided';

export interface OrderEventBase {
  eventId: string;
  occurredAt: string;
  affectedTableIds: string[];
}

export interface OrderSessionOpenedPayload extends OrderEventBase {
  sessionId: string;
  tableId: string | null;
  employeeId: string;
  shiftId: string | null;
}

export interface OrderItemsAddedPayload extends OrderEventBase {
  sessionId: string;
  tableId: string | null;
  orderItemIds: string[];
}

export interface OrderItemStatusUpdatedPayload extends OrderEventBase {
  orderItemId: string;
  orderSessionId: string;
  tableId: string | null;
  previousStatus: ServeStatus;
  currentStatus: ServeStatus;
  isServed: boolean;
}

export interface OrderSessionCancelledPayload extends OrderEventBase {
  sessionId: string;
  tableId: string | null;
}

export interface OrderSessionTableTransferredPayload extends OrderEventBase {
  sessionId: string;
  fromTableId: string;
  toTableId: string;
}

export interface OrderSessionsMergedPayload extends OrderEventBase {
  targetSessionId: string;
  destinationTableId: string;
  sourceSessionIds: string[];
  sourceTableIds: string[];
}

export interface OrderSessionSplitPayload extends OrderEventBase {
  sourceSessionId: string;
  newSessionId: string;
  sourceTableId: string | null;
  destinationTableId: string;
}

export interface OrderTableClearedPayload extends OrderEventBase {
  tableId: string;
  cancelledSessionId: string | null;
}

export interface OrderInvoicePayload extends OrderEventBase {
  invoiceId: string;
  invoiceNumber: string;
  orderSessionId: string;
  tableId: string | null;
}

export interface OrderEventPayloadMap {
  'order.session.opened': OrderSessionOpenedPayload;
  'order.items.added': OrderItemsAddedPayload;
  'order.item.status.updated': OrderItemStatusUpdatedPayload;
  'order.session.cancelled': OrderSessionCancelledPayload;
  'order.session.table.transferred': OrderSessionTableTransferredPayload;
  'order.sessions.merged': OrderSessionsMergedPayload;
  'order.session.split': OrderSessionSplitPayload;
  'order.table.cleared': OrderTableClearedPayload;
  'order.invoice.created': OrderInvoicePayload;
  'order.invoice.paid': OrderInvoicePayload;
  'order.invoice.voided': OrderInvoicePayload;
}

export type OrderEventListener<TEventName extends OrderEventName> = (
  payload: OrderEventPayloadMap[TEventName],
) => void | Promise<void>;
