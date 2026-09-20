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
  expiresAt: Date;
  locale: 'vn' | 'en';
  bankCode?: string;
}

export interface VnpayCallbackVerification {
  isValid: boolean;
  params: Record<string, string>;
  payloadHash: string;
}
