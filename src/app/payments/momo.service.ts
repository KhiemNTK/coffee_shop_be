import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import {
  BadRequestException,
  BadGatewayException,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import { z } from 'zod';

const MomoCallbackSchema = z.object({
  partnerCode: z.string(),
  orderId: z.string(),
  requestId: z.string(),
  amount: z.coerce.number().int().positive().refine(Number.isSafeInteger),
  extraData: z.string(),
  message: z.string(),
  orderInfo: z.string(),
  orderType: z.string(),
  payType: z.string(),
  responseTime: z.coerce.number().int().refine(Number.isSafeInteger),
  resultCode: z.coerce.number().int(),
  transId: z.coerce.number().int().refine(Number.isSafeInteger),
  signature: z.string().regex(/^[a-fA-F0-9]{64}$/),
});

const MomoCreateResponseSchema = z.object({
  partnerCode: z.string(),
  orderId: z.string(),
  requestId: z.string(),
  amount: z.number().int().refine(Number.isSafeInteger),
  message: z.string(),
  resultCode: z.number().int(),
  payUrl: z.string().optional(),
  responseTime: z.number().int().refine(Number.isSafeInteger),
  signature: z.string().regex(/^[a-fA-F0-9]{64}$/),
});

const MomoQueryResponseSchema = z.object({
  partnerCode: z.string(),
  orderId: z.string(),
  requestId: z.string(),
  amount: z.number().int().refine(Number.isSafeInteger).optional(),
  transId: z.number().int().refine(Number.isSafeInteger).optional(),
  resultCode: z.number().int(),
  message: z.string(),
});

export type MomoCallback = z.infer<typeof MomoCallbackSchema>;

@Injectable()
export class MomoService {
  constructor(private readonly config: ConfigService) {}

  assertConfigured() {
    this.credentials();
  }

  async createPaymentUrl(input: {
    merchantReference: string;
    invoiceNumber: string;
    amount: Prisma.Decimal;
    locale?: 'vn' | 'en';
  }) {
    const { partnerCode, accessKey, secretKey, redirectUrl, ipnUrl } =
      this.credentials();
    const amount = this.assertAmount(input.amount);
    const fields = {
      accessKey,
      amount,
      extraData: '',
      ipnUrl,
      orderId: input.merchantReference,
      orderInfo: `Thanh toan hoa don ${input.invoiceNumber}`.slice(0, 255),
      partnerCode,
      redirectUrl,
      requestId: input.merchantReference,
      requestType: 'captureWallet',
    };
    const request = {
      partnerCode,
      requestType: fields.requestType,
      ipnUrl,
      redirectUrl,
      orderId: fields.orderId,
      amount: Number(amount),
      orderInfo: fields.orderInfo,
      requestId: fields.requestId,
      extraData: fields.extraData,
      autoCapture: true,
      lang: input.locale === 'en' ? 'en' : 'vi',
      signature: this.sign(fields, secretKey),
    };
    const parsed = MomoCreateResponseSchema.safeParse(
      await this.post('/v2/gateway/api/create', request),
    );
    if (!parsed.success)
      throw new BadGatewayException('Invalid MoMo payment response.');
    const response = parsed.data;
    if (
      response.partnerCode !== partnerCode ||
      response.orderId !== fields.orderId ||
      response.requestId !== fields.requestId ||
      response.amount !== request.amount ||
      !this.equal(
        response.signature,
        this.sign(
          {
            accessKey,
            amount: String(response.amount),
            orderId: response.orderId,
            partnerCode: response.partnerCode,
            payUrl: response.payUrl ?? '',
            requestId: response.requestId,
            responseTime: String(response.responseTime),
            resultCode: String(response.resultCode),
          },
          secretKey,
        ),
      )
    ) {
      throw new BadGatewayException('Invalid MoMo payment response.');
    }
    if (response.resultCode !== 0 || !response.payUrl) {
      throw new BadGatewayException('MoMo could not create a payment link.');
    }
    const url = new URL(response.payUrl);
    if (url.protocol !== 'https:' || !url.hostname.endsWith('.momo.vn')) {
      throw new BadGatewayException('Invalid MoMo payment URL.');
    }
    return response.payUrl;
  }

  verifyCallback(raw: unknown) {
    const payload = MomoCallbackSchema.safeParse(raw);
    if (!payload.success) return null;
    const { accessKey, partnerCode, secretKey } = this.credentials();
    const data = payload.data;
    if (data.partnerCode !== partnerCode || data.requestId !== data.orderId) {
      return null;
    }
    const signature = this.sign(
      {
        accessKey,
        amount: String(data.amount),
        extraData: data.extraData,
        message: data.message,
        orderId: data.orderId,
        orderInfo: data.orderInfo,
        orderType: data.orderType,
        partnerCode: data.partnerCode,
        payType: data.payType,
        requestId: data.requestId,
        responseTime: String(data.responseTime),
        resultCode: String(data.resultCode),
        transId: String(data.transId),
      },
      secretKey,
    );
    if (!this.equal(data.signature, signature)) return null;
    return {
      data,
      payloadHash: createHash('sha256')
        .update(`${partnerCode}:${data.orderId}:${data.signature}`)
        .digest('hex'),
    };
  }

  async queryTransaction(input: {
    requestId: string;
    merchantReference: string;
  }) {
    const { partnerCode, accessKey, secretKey } = this.credentials();
    const request = {
      partnerCode,
      requestId: input.requestId,
      orderId: input.merchantReference,
      lang: 'vi',
      signature: this.sign(
        {
          accessKey,
          orderId: input.merchantReference,
          partnerCode,
          requestId: input.requestId,
        },
        secretKey,
      ),
    };
    const parsed = MomoQueryResponseSchema.safeParse(
      await this.post('/v2/gateway/api/query', request),
    );
    if (!parsed.success)
      throw new BadGatewayException('Invalid MoMo transaction response.');
    const response = parsed.data;
    if (
      response.partnerCode !== partnerCode ||
      response.orderId !== request.orderId ||
      response.requestId !== request.requestId
    ) {
      throw new BadGatewayException('Invalid MoMo transaction response.');
    }
    return { request, response };
  }

  assertAmount(amount: Prisma.Decimal) {
    if (!amount.isInteger() || amount.lt(1_000) || amount.gt(50_000_000)) {
      throw new BadRequestException(
        'MoMo amount must be an integer between 1,000 and 50,000,000 VND.',
      );
    }
    return amount.toFixed(0);
  }

  private credentials() {
    const partnerCode = this.config.get<string>('MOMO_PARTNER_CODE');
    const accessKey = this.config.get<string>('MOMO_ACCESS_KEY');
    const secretKey = this.config.get<string>('MOMO_SECRET_KEY');
    const redirectUrl = this.config.get<string>('MOMO_REDIRECT_URL');
    const ipnUrl = this.config.get<string>('MOMO_IPN_URL');
    if (!partnerCode || !accessKey || !secretKey || !redirectUrl || !ipnUrl) {
      throw new ServiceUnavailableException('MoMo payment is not configured.');
    }
    return { partnerCode, accessKey, secretKey, redirectUrl, ipnUrl };
  }

  private async post(path: string, body: object): Promise<unknown> {
    const baseUrl = this.config.get<string>(
      'MOMO_API_URL',
      'https://test-payment.momo.vn',
    );
    const timeout = this.config.get<number>('MOMO_API_TIMEOUT_MS', 30_000);
    try {
      const response = await fetch(new URL(path, baseUrl), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeout),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return (await response.json()) as unknown;
    } catch {
      throw new BadGatewayException('MoMo gateway is unavailable.');
    }
  }

  private sign(fields: Record<string, string>, secret: string) {
    const canonical = Object.entries(fields)
      .map(([key, value]) => `${key}=${value}`)
      .join('&');
    return createHmac('sha256', secret).update(canonical).digest('hex');
  }

  private equal(actual: string, expected: string) {
    const left = Buffer.from(actual.toLowerCase(), 'hex');
    const right = Buffer.from(expected, 'hex');
    return left.length === right.length && timingSafeEqual(left, right);
  }
}
