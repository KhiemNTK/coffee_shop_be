import type { Decimal } from '@prisma/client/runtime/library';

export type PaymentCallbackQuery = Record<
  string,
  string | string[] | undefined
>;

export interface VnpayPaymentUrlInput {
  amount: Decimal;
  invoiceNumber: string;
  merchantReference: string;
  ipAddress: string;
  providerCreatedAt: Date;
  expiresAt: Date;
  locale: 'vn' | 'en';
  bankCode?: string;
}

export interface VnpayQueryInput {
  requestId: string;
  merchantReference: string;
  providerCreatedAt: Date;
  orderInfo: string;
}

export interface VnpayRefundInput extends VnpayQueryInput {
  amount: Decimal;
  createdBy: string;
  providerTransactionNo?: string | null;
  transactionType: '02' | '03';
}

export interface VnpayApiResult {
  request: Record<string, string>;
  response: Record<string, string>;
}

export interface VnpayCallbackVerification {
  isValid: boolean;
  params: Record<string, string>;
  payloadHash: string;
}
