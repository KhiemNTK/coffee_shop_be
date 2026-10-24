import type { PaymentMethod, PaymentStatus, ServeStatus } from '@prisma/client';
import type { Decimal } from '@prisma/client/runtime/library';

export interface InvoiceLineSnapshot {
  id: string;
  quantity: number;
  priceAtTime: Decimal;
  serveStatus: ServeStatus;
  isPaid: boolean;
  invoiceId: string | null;
  menuItemId: string;
  menuItem: { id: string; name: string };
  note: string | null;
  selectedOptions: unknown;
}

export type InvoiceDocumentSnapshot = {
  version: 1;
  source: 'ISSUED' | 'LEGACY_BACKFILL';
  tableId: string | null;
  tableName: string | null;
  issuedByName: string;
  promotionName: string | null;
  items: {
    orderItemId: string;
    menuItemId: string;
    name: string;
    quantity: number;
    unitPrice: string;
    note: string | null;
    selectedOptions: {
      id: string;
      groupName: string;
      name: string;
      priceDelta: string;
    }[];
  }[];
};

export interface InvoiceCalculationResult {
  subTotal: Decimal;
  discountAmount: Decimal;
  taxAmount: Decimal;
  taxRate: Decimal;
  totalAmount: Decimal;
  amountTendered: Decimal | null;
  changeAmount: Decimal | null;
}

export interface CreateInvoiceInput {
  orderSessionId: string;
  orderItemIds?: string[];
  promotionId?: string | null;
  taxRate?: string | number;
  quoteFingerprint?: string;
  expectedTotal?: string | number;
}

export interface InvoicePaymentTransition {
  paymentStatus: PaymentStatus;
  paymentMethod?: PaymentMethod;
  amountTendered?: string | number;
  closeSessionAfterPayment?: boolean;
}
