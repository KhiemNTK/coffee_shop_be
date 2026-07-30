export const ORDER_EVENTS = {
  SESSION_OPENED: 'order.session.opened',
  ITEMS_ADDED: 'order.items.added',
  ITEM_STATUS_UPDATED: 'order.item.status.updated',
  SESSION_CANCELLED: 'order.session.cancelled',
  SESSION_TABLE_TRANSFERRED: 'order.session.table.transferred',
  SESSIONS_MERGED: 'order.sessions.merged',
  SESSION_SPLIT: 'order.session.split',
  TABLE_CLEARED: 'order.table.cleared',
  INVOICE_CREATED: 'order.invoice.created',
  INVOICE_PAID: 'order.invoice.paid',
  INVOICE_VOIDED: 'order.invoice.voided',
} as const;
