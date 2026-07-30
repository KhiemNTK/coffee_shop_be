import {
  OrderSession as PrismaOrderSession,
  SessionStatus,
} from '@prisma/client';

export class OrderSessionEntity implements PrismaOrderSession {
  id!: string;
  sessionStatus!: SessionStatus;
  guestCount!: number | null;
  createdAt!: Date;
  updatedAt!: Date;
  tableId!: string | null;
  employeeId!: string;
  shiftId!: string | null;
}
