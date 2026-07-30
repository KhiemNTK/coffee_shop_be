import type { Prisma, ServeStatus } from '@prisma/client';

export interface OpenSessionInput {
  tableId?: string | null;
  employeeId: string;
  guestCount?: number;
  shiftId?: string | null;
}

export interface MenuItemPriceSnapshot {
  id: string;
  price: Prisma.Decimal;
}

export interface SplittableOrderItem {
  id: string;
  orderSessionId: string;
  isPaid: boolean;
  invoiceId: string | null;
  serveStatus: ServeStatus;
  quantity: number;
  menuItemId: string;
  priceAtTime: Prisma.Decimal;
  note: string | null;
}
