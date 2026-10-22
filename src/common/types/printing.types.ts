import type {
  PrintDeviceStatus,
  PrintDeviceType,
  PrintJobType,
  Prisma,
} from '@prisma/client';

export interface AuthenticatedPrintDevice {
  id: string;
  type: PrintDeviceType;
  status: PrintDeviceStatus;
}

export interface ClaimedPrintJob {
  id: string;
  type: PrintJobType;
  payload: Prisma.JsonValue;
  copies: number;
  attempts: number;
  leaseExpiresAt: Date;
}

export interface ReceiptPrintPayload extends Prisma.JsonObject {
  isReprint: boolean;
  invoiceId: string;
  invoiceNumber: string;
  createdAt: string;
  tableName: string | null;
  cashierName: string;
  paymentMethod: string;
  paymentStatus: string;
  subTotal: string;
  discountAmount: string;
  taxAmount: string;
  totalAmount: string;
  amountTendered: string | null;
  changeAmount: string | null;
  items: Prisma.JsonArray;
}

export interface PrecheckPrintPayload extends Prisma.JsonObject {
  documentType: 'PRECHECK';
  title: string;
  paymentStatus: 'UNPAID';
  orderSessionId: string;
  createdAt: string;
  tableName: string | null;
  cashierName: string;
  promotionId: string | null;
  subTotal: string;
  discountAmount: string;
  taxAmount: string;
  taxRate: string;
  totalAmount: string;
  items: Prisma.JsonArray;
}
