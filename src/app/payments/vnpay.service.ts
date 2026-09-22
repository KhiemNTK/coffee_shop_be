import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import {
  BadGatewayException,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type {
  PaymentCallbackQuery,
  VnpayApiResult,
  VnpayCallbackVerification,
  VnpayPaymentUrlInput,
  VnpayQueryInput,
  VnpayRefundInput,
} from '../../common/types';

const VNPAY_VERSION = '2.1.0';
const VIETNAM_UTC_OFFSET_MS = 7 * 60 * 60 * 1000;

@Injectable()
export class VnpayService {
  constructor(private readonly config: ConfigService) {}

  assertConfigured() {
    this.getConfig();
  }

  assertApiConfigured() {
    this.getApiConfig();
  }

  createPaymentUrl(input: VnpayPaymentUrlInput) {
    const { paymentUrl, returnUrl, tmnCode, hashSecret } = this.getConfig();
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
      vnp_CreateDate: this.formatVietnamTime(input.providerCreatedAt),
      vnp_ExpireDate: this.formatVietnamTime(input.expiresAt),
      ...(input.bankCode ? { vnp_BankCode: input.bankCode } : {}),
    };
    const query = this.toSignedQuery(params);
    const secureHash = this.sign(query, hashSecret);
    return `${paymentUrl}?${query}&vnp_SecureHash=${secureHash}`;
  }

  queryTransaction(input: VnpayQueryInput) {
    const { apiUrl, hashSecret, serverIp, timeoutMs, tmnCode } =
      this.getApiConfig();
    const params: Record<string, string> = {
      vnp_RequestId: input.requestId,
      vnp_Version: VNPAY_VERSION,
      vnp_Command: 'querydr',
      vnp_TmnCode: tmnCode,
      vnp_TxnRef: input.merchantReference,
      vnp_TransactionDate: this.formatVietnamTime(input.providerCreatedAt),
      vnp_CreateDate: this.formatVietnamTime(new Date()),
      vnp_IpAddr: serverIp,
      vnp_OrderInfo: input.orderInfo,
    };
    return this.sendApiRequest(
      params,
      [
        'vnp_RequestId',
        'vnp_Version',
        'vnp_Command',
        'vnp_TmnCode',
        'vnp_TxnRef',
        'vnp_TransactionDate',
        'vnp_CreateDate',
        'vnp_IpAddr',
        'vnp_OrderInfo',
      ],
      [
        'vnp_ResponseId',
        'vnp_Command',
        'vnp_ResponseCode',
        'vnp_Message',
        'vnp_TmnCode',
        'vnp_TxnRef',
        'vnp_Amount',
        'vnp_BankCode',
        'vnp_PayDate',
        'vnp_TransactionNo',
        'vnp_TransactionType',
        'vnp_TransactionStatus',
        'vnp_OrderInfo',
        'vnp_PromotionCode',
        'vnp_PromotionAmount',
      ],
      hashSecret,
      apiUrl,
      timeoutMs,
    );
  }

  refundTransaction(input: VnpayRefundInput) {
    const { apiUrl, hashSecret, serverIp, timeoutMs, tmnCode } =
      this.getApiConfig();
    const params: Record<string, string> = {
      vnp_RequestId: input.requestId,
      vnp_Version: VNPAY_VERSION,
      vnp_Command: 'refund',
      vnp_TmnCode: tmnCode,
      vnp_TransactionType: input.transactionType,
      vnp_TxnRef: input.merchantReference,
      vnp_Amount: input.amount.mul(100).toFixed(0),
      vnp_TransactionNo: input.providerTransactionNo ?? '',
      vnp_TransactionDate: this.formatVietnamTime(input.providerCreatedAt),
      vnp_CreateBy: input.createdBy.slice(0, 245),
      vnp_CreateDate: this.formatVietnamTime(new Date()),
      vnp_IpAddr: serverIp,
      vnp_OrderInfo: input.orderInfo,
    };
    return this.sendApiRequest(
      params,
      [
        'vnp_RequestId',
        'vnp_Version',
        'vnp_Command',
        'vnp_TmnCode',
        'vnp_TransactionType',
        'vnp_TxnRef',
        'vnp_Amount',
        'vnp_TransactionNo',
        'vnp_TransactionDate',
        'vnp_CreateBy',
        'vnp_CreateDate',
        'vnp_IpAddr',
        'vnp_OrderInfo',
      ],
      [
        'vnp_ResponseId',
        'vnp_Command',
        'vnp_ResponseCode',
        'vnp_Message',
        'vnp_TmnCode',
        'vnp_TxnRef',
        'vnp_Amount',
        'vnp_BankCode',
        'vnp_PayDate',
        'vnp_TransactionNo',
        'vnp_TransactionType',
        'vnp_TransactionStatus',
        'vnp_OrderInfo',
      ],
      hashSecret,
      apiUrl,
      timeoutMs,
    );
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

  private getApiConfig() {
    const tmnCode = this.config.get<string>('VNPAY_TMN_CODE');
    const hashSecret = this.config.get<string>('VNPAY_HASH_SECRET');
    const apiUrl = this.config.get<string>('VNPAY_API_URL');
    const serverIp = this.config.get<string>('VNPAY_SERVER_IP');
    const timeoutMs = this.config.get<number>('VNPAY_API_TIMEOUT_MS', 5_000);
    if (!tmnCode || !hashSecret || !apiUrl || !serverIp) {
      throw new ServiceUnavailableException(
        'VNPay reconciliation API is not configured for this environment.',
      );
    }
    return { tmnCode, hashSecret, apiUrl, serverIp, timeoutMs };
  }

  private async sendApiRequest(
    params: Record<string, string>,
    requestSignatureFields: string[],
    responseSignatureFields: string[],
    hashSecret: string,
    apiUrl: string,
    timeoutMs: number,
  ): Promise<VnpayApiResult> {
    const request = { ...params };
    const body = {
      ...request,
      vnp_SecureHash: this.signFields(
        request,
        requestSignatureFields,
        hashSecret,
      ),
    };
    let response: Response;
    try {
      response = await fetch(apiUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      throw new BadGatewayException('VNPay API request failed.');
    }
    if (!response.ok) {
      throw new BadGatewayException(
        `VNPay API returned HTTP ${response.status}.`,
      );
    }

    const payload: unknown = await response.json().catch(() => null);
    const normalized = this.normalizeApiResponse(payload);
    const receivedHash = normalized.vnp_SecureHash;
    if (
      !receivedHash ||
      !this.safeEqual(
        this.signFields(normalized, responseSignatureFields, hashSecret),
        receivedHash.toLowerCase(),
      )
    ) {
      throw new BadGatewayException('VNPay API response signature is invalid.');
    }
    if (
      normalized.vnp_TmnCode !== params.vnp_TmnCode ||
      normalized.vnp_Command !== params.vnp_Command
    ) {
      throw new BadGatewayException(
        'VNPay API response does not match the request.',
      );
    }
    delete normalized.vnp_SecureHash;
    return { request, response: normalized };
  }

  private normalizeApiResponse(payload: unknown) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      throw new BadGatewayException('VNPay API returned an invalid payload.');
    }
    const normalized: Record<string, string> = {};
    for (const [key, value] of Object.entries(payload)) {
      if (typeof value !== 'string' && typeof value !== 'number') {
        throw new BadGatewayException('VNPay API returned an invalid payload.');
      }
      normalized[key] = String(value);
    }
    return normalized;
  }

  private signFields(
    params: Record<string, string>,
    fields: string[],
    secret: string,
  ) {
    return this.sign(
      fields.map((field) => params[field] ?? '').join('|'),
      secret,
    );
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
