import type {
  DiscountType,
  PaymentMethod,
  PaymentStatus,
  ServeStatus,
} from '@prisma/client';
import type { Decimal } from '@prisma/client/runtime/library';

export interface InvoiceLineSnapshot {
  id: string;
  quantity: number;
  priceAtTime: Decimal;
  serveStatus: ServeStatus;
  isPaid: boolean;
  invoiceId: string | null;
}

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
}

export interface InvoicePaymentTransition {
  paymentStatus: PaymentStatus;
  paymentMethod?: PaymentMethod;
  amountTendered?: string | number;
  closeSessionAfterPayment?: boolean;
}

export interface InvoicePromotionSnapshot {
  id: string;
  discountType: DiscountType;
  discountValue: Decimal;
  maxDiscount: Decimal | null;
  startDate: Date;
  endDate: Date;
}
