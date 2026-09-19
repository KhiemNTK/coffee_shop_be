import type { PaymentMethod, ReservationStatus } from '@prisma/client';
import type { Decimal } from '@prisma/client/runtime/library';

export type ReportGranularity = 'hour' | 'day';

export interface ReportQueryPeriod {
  from: Date;
  to: Date;
  timeZone: string;
  granularity: ReportGranularity;
}

export interface ReportSummaryRow {
  paidInvoiceCount: bigint;
  grossSales: Decimal;
  discountAmount: Decimal;
  taxAmount: Decimal;
  netRevenue: Decimal;
  averageTicket: Decimal;
  cancelledItemCount: bigint;
  wasteEntryCount: bigint;
  closedShiftCount: bigint;
  discrepantShiftCount: bigint;
  cashShortageAmount: Decimal;
  cashOverageAmount: Decimal;
}

export interface ReportTrendRow {
  bucket: string;
  paidInvoiceCount: bigint;
  netRevenue: Decimal;
}

export interface ReportPaymentMethodRow {
  paymentMethod: PaymentMethod;
  paidInvoiceCount: bigint;
  netRevenue: Decimal;
}

export interface ReportMenuItemRow {
  menuItemId: string;
  name: string;
  categoryName: string;
  quantitySold: bigint;
  grossSales: Decimal;
}

export interface ReportPromotionRow {
  promotionId: string;
  name: string;
  usageCount: bigint;
  discountAmount: Decimal;
  netRevenue: Decimal;
}

export interface ReportReservationRow {
  status: ReservationStatus;
  reservationCount: bigint;
}

export interface ReportInventoryWasteRow {
  inventoryItemId: string;
  name: string;
  unitName: string;
  wasteQuantity: Decimal;
}
