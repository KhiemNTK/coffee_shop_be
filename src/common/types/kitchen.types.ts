import type { Prisma } from '@prisma/client';

export type KitchenTicketState =
  | 'PENDING'
  | 'IN_PROGRESS'
  | 'COMPLETED'
  | 'CANCELLED';

export interface KitchenRoutableMenuItem {
  id: string;
  name: string;
  price: Prisma.Decimal;
  kitchenStation: {
    id: string;
    code: string;
    name: string;
    prepSlaSeconds: number;
    printDevice: {
      id: string;
      isActive: boolean;
      deletedAt: Date | null;
    } | null;
  } | null;
}

export interface KitchenRoutableOrderItem {
  id: string;
  menuItemId: string;
  quantity: number;
  note: string | null;
}

export interface KitchenRealtimeEvent {
  eventId: string;
  eventName: string;
  occurredAt: string;
}
