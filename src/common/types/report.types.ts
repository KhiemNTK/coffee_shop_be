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

export interface ReportCashRiskOverviewRow {
  openingDiscrepantShiftCount: bigint;
  openingShortageAmount: Decimal;
  openingOverageAmount: Decimal;
  repeatShortageEmployeeCount: bigint;
  currentPendingExpenseRequestCount: bigint;
  currentPendingExpenseRequestAmount: Decimal;
  rejectedExpenseRequestCount: bigint;
  rejectedExpenseRequestAmount: Decimal;
  currentPendingHandoverCount: bigint;
  currentPendingHandoverAmount: Decimal;
  approvedHandoverCount: bigint;
  approvedHandoverAmount: Decimal;
  currentPendingBankSettlementCount: bigint;
  currentPendingBankSettlementAmount: Decimal;
  overdueBankSettlementCount: bigint;
  overdueBankSettlementAmount: Decimal;
  settledBankDepositCount: bigint;
  settledBankDepositAmount: Decimal;
  currentUnmatchedBankStatementEntryCount: bigint;
  currentUnmatchedBankStatementEntryAmount: Decimal;
  currentMismatchedBankStatementEntryCount: bigint;
  currentMismatchedBankStatementEntryAmount: Decimal;
}

export interface ReportEmployeeCashRiskRow {
  employeeId: string;
  employeeName: string;
  closedShiftCount: bigint;
  shortageShiftCount: bigint;
  overageShiftCount: bigint;
  totalShortageAmount: Decimal;
  totalOverageAmount: Decimal;
  openingShortageAmount: Decimal;
  openingOverageAmount: Decimal;
}

export interface ReportCashVarianceTrendRow {
  bucket: string;
  closedShiftCount: bigint;
  discrepantShiftCount: bigint;
  cashShortageAmount: Decimal;
  cashOverageAmount: Decimal;
}
