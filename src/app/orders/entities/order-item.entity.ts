import {
  OrderItem as PrismaOrderItem,
  Prisma,
  ServeStatus,
} from '@prisma/client';

export class OrderItemEntity implements PrismaOrderItem {
  id!: string;
  quantity!: number;
  priceAtTime!: Prisma.Decimal;
  note!: string | null;
  serveStatus!: ServeStatus;
  isPaid!: boolean;
  createdAt!: Date;
  updatedAt!: Date;
  orderSessionId!: string;
  menuItemId!: string;
  invoiceId!: string | null;
}
