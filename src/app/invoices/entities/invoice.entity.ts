import {
  Invoice as InvoicePrisma,
  PaymentMethod,
  PaymentStatus,
} from '@prisma/client';
import { Decimal } from '@prisma/client/runtime/library';

export class InvoiceEntity implements InvoicePrisma {
  id!: string;
  invoiceNumber!: string;
  subTotal!: Decimal;
  discountAmount!: Decimal;
  totalAmount!: Decimal;
  amountTendered!: Decimal | null;
  changeAmount!: Decimal | null;
  paymentMethod!: PaymentMethod;
  paymentStatus!: PaymentStatus;
  taxAmount!: Decimal;
  taxRate!: Decimal;
  createdAt!: Date;
  updatedAt!: Date;
  orderSessionId!: string;
  employeeId!: string;
  shiftId!: string | null;
  promotionId!: string | null;
}
