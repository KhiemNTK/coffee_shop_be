import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type {
  PaymentCallbackQuery,
  VnpayCallbackVerification,
  VnpayPaymentUrlInput,
} from '../../common/types';

const VNPAY_VERSION = '2.1.0';
const VIETNAM_UTC_OFFSET_MS = 7 * 60 * 60 * 1000;

@Injectable()
export class VnpayService {
  constructor(private readonly config: ConfigService) {}

  assertConfigured() {
    this.getConfig();
  }

  createPaymentUrl(input: VnpayPaymentUrlInput) {
    const { paymentUrl, returnUrl, tmnCode, hashSecret } = this.getConfig();
    const now = new Date();
    const params: Record<string, string> = {
      vnp_Version: VNPAY_VERSION,
      vnp_Command: 'pay',
      vnp_TmnCode: tmnCode,
      vnp_Amount: input.amount.mul(100).toFixed(0),
      vnp_CurrCode: 'VND',
      vnp_TxnRef: input.merchantReference,
      vnp_OrderInfo: `Thanh toan hoa don ${input.invoiceNumber}`,
      vnp_OrderType: 'other',
      vnp_Locale: input.locale,
      vnp_ReturnUrl: returnUrl,
      vnp_IpAddr: input.ipAddress,
      vnp_CreateDate: this.formatVietnamTime(now),
      vnp_ExpireDate: this.formatVietnamTime(input.expiresAt),
      ...(input.bankCode ? { vnp_BankCode: input.bankCode } : {}),
    };
    const query = this.toSignedQuery(params);
    const secureHash = this.sign(query, hashSecret);
    return `${paymentUrl}?${query}&vnp_SecureHash=${secureHash}`;
  }

  verifyCallback(query: PaymentCallbackQuery): VnpayCallbackVerification {
    const params = this.normalizeQuery(query);
    const payloadHash = createHash('sha256')
      .update(this.canonicalPayload(query))
      .digest('hex');
    const receivedHash = params?.vnp_SecureHash;
    const tmnCode = this.config.get<string>('VNPAY_TMN_CODE');
    const hashSecret = this.config.get<string>('VNPAY_HASH_SECRET');
    if (!params || !receivedHash || !tmnCode || !hashSecret) {
      return { isValid: false, params: params ?? {}, payloadHash };
    }
    if (params.vnp_TmnCode !== tmnCode) {
      return { isValid: false, params, payloadHash };
    }

    const signedParams = { ...params };
    delete signedParams.vnp_SecureHash;
    delete signedParams.vnp_SecureHashType;
    const expectedHash = this.sign(
      this.toSignedQuery(signedParams),
      hashSecret,
    );
    return {
      isValid: this.safeEqual(expectedHash, receivedHash.toLowerCase()),
      params,
      payloadHash,
    };
  }

  private getConfig() {
    const paymentUrl = this.config.get<string>('VNPAY_PAYMENT_URL');
    const returnUrl = this.config.get<string>('VNPAY_RETURN_URL');
    const tmnCode = this.config.get<string>('VNPAY_TMN_CODE');
    const hashSecret = this.config.get<string>('VNPAY_HASH_SECRET');
    if (!paymentUrl || !returnUrl || !tmnCode || !hashSecret) {
      throw new ServiceUnavailableException(
        'VNPay is not configured for this environment.',
      );
    }
    return { paymentUrl, returnUrl, tmnCode, hashSecret };
  }

  private normalizeQuery(query: PaymentCallbackQuery) {
    const params: Record<string, string> = {};
    for (const [key, value] of Object.entries(query)) {
      if (typeof value !== 'string') return null;
      params[key] = value;
    }
    return params;
  }

  private canonicalPayload(query: PaymentCallbackQuery) {
    return JSON.stringify(
      Object.entries(query)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, value]) => [key, value ?? null]),
    );
  }

  private toSignedQuery(params: Record<string, string>) {
    const search = new URLSearchParams();
    Object.entries(params)
      .filter(
        ([key, value]) =>
          key.startsWith('vnp_') &&
          key !== 'vnp_SecureHash' &&
          key !== 'vnp_SecureHashType' &&
          value !== '',
      )
      .sort(([left], [right]) => left.localeCompare(right))
      .forEach(([key, value]) => search.append(key, value));
    return search.toString();
  }

  private sign(data: string, secret: string) {
    return createHmac('sha512', secret).update(data).digest('hex');
  }

  private safeEqual(left: string, right: string) {
    const leftBuffer = Buffer.from(left);
    const rightBuffer = Buffer.from(right);
    return (
      leftBuffer.length === rightBuffer.length &&
      timingSafeEqual(leftBuffer, rightBuffer)
    );
  }

  private formatVietnamTime(date: Date) {
    const shifted = new Date(date.getTime() + VIETNAM_UTC_OFFSET_MS);
    const pad = (value: number) => value.toString().padStart(2, '0');
    return [
      shifted.getUTCFullYear(),
      pad(shifted.getUTCMonth() + 1),
      pad(shifted.getUTCDate()),
      pad(shifted.getUTCHours()),
      pad(shifted.getUTCMinutes()),
      pad(shifted.getUTCSeconds()),
    ].join('');
  }
}
