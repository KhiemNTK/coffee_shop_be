import type { Decimal } from '@prisma/client/runtime/library';

export type PaymentConfirmationSource = 'MANUAL' | 'SCHEDULED' | 'WEBHOOK';

export type PaymentCallbackQuery = Record<
  string,
  string | string[] | undefined
>;

export interface PayosPaymentUrlInput {
  paymentAttemptId: string;
  amount: Decimal;
  merchantReference: string;
  expiresAt: Date;
}

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

export type VnpayApiFailureCode =
  | 'VNPAY_NOT_CONFIGURED'
  | 'VNPAY_API_TIMEOUT'
  | 'VNPAY_API_NETWORK_ERROR'
  | 'VNPAY_API_HTTP_ERROR'
  | 'VNPAY_API_INVALID_PAYLOAD'
  | 'VNPAY_API_SIGNATURE_MISSING'
  | 'VNPAY_API_SIGNATURE_INVALID'
  | 'VNPAY_API_RESPONSE_MISMATCH';

export interface VnpayApiDiagnostics {
  providerHttpStatus?: number;
  providerResponseCode?: string;
  verification?: 'missing' | 'invalid' | 'verified';
  networkCode?: string;
}

export interface VnpayCallbackVerification {
  isValid: boolean;
  params: Record<string, string>;
  payloadHash: string;
}
