import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import {
  BadGatewayException,
  BadRequestException,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PayOS } from '@payos/node';
import type { Decimal } from '@prisma/client/runtime/library';
import { z } from 'zod';
import type { PayosPaymentUrlInput } from '../../common/types';
import { PayosWebhookDto } from './dto';

export const PAYOS_PAYMENT_NOTIFIED = 'payos.payment.notified';
const LinkIdSchema = z.string().regex(/^[a-f0-9]{32}$/);
const IntegerSchema = z.number().int().nonnegative().safe();
const StatusSchema = z.enum([
  'PENDING',
  'CANCELLED',
  'UNDERPAID',
  'PAID',
  'EXPIRED',
  'PROCESSING',
  'FAILED',
]);
const LinkSchema = z.object({
  id: LinkIdSchema,
  orderCode: IntegerSchema.positive(),
  amount: IntegerSchema.positive(),
  amountPaid: IntegerSchema,
  amountRemaining: z.number().int().safe(),
  status: StatusSchema,
  transactions: z
    .array(
      z.object({
        reference: z.string().min(1).max(128),
        amount: IntegerSchema,
      }),
    )
    .max(1000),
});
const CreateLinkSchema = z.object({
  paymentLinkId: LinkIdSchema,
  orderCode: IntegerSchema.positive(),
  amount: IntegerSchema.positive(),
  currency: z.literal('VND'),
  status: StatusSchema,
  checkoutUrl: z.url(),
});

@Injectable()
export class PayosService {
  private client?: PayOS;

  constructor(private readonly config: ConfigService) {}

  assertConfigured() {
    for (const key of [
      'PAYOS_CLIENT_ID',
      'PAYOS_API_KEY',
      'PAYOS_CHECKSUM_KEY',
      'PAYOS_RETURN_URL',
      'JWT_SECRET',
    ]) {
      if (!this.config.get<string>(key))
        throw new ServiceUnavailableException('payOS is not configured.');
    }
  }

  assertAmount(amount: Decimal) {
    if (
      !amount.isInteger() ||
      amount.lte(0) ||
      amount.gt(Number.MAX_SAFE_INTEGER)
    )
      throw new BadRequestException(
        'payOS requires a positive, safe integer amount in VND.',
      );
    return amount.toNumber();
  }

  async createPaymentUrl(input: PayosPaymentUrlInput) {
    const client = this.sdk();
    const orderCode = this.orderCode(input.merchantReference);
    const amount = this.assertAmount(input.amount);
    const returnUrl = new URL(
      this.config.getOrThrow<string>('PAYOS_RETURN_URL'),
    );
    returnUrl.searchParams.set(
      'state',
      this.returnState(input.paymentAttemptId),
    );
    let response: unknown;
    try {
      response = await client.paymentRequests.create({
        orderCode,
        amount,
        description: `COFFEE ${orderCode}`,
        expiredAt: Math.floor(input.expiresAt.getTime() / 1000),
        returnUrl: returnUrl.href,
        cancelUrl: returnUrl.href,
      });
    } catch {
      // A lost response may already have created the link; never allocate another order code.
      const existing = await this.queryTransaction(input.merchantReference);
      if (
        existing.amount !== amount ||
        !['PENDING', 'UNDERPAID', 'PROCESSING'].includes(existing.status)
      )
        throw new BadGatewayException(
          'payOS link is unavailable; reconcile the existing attempt.',
        );
      return `https://pay.payos.vn/web/${existing.id}`;
    }
    const parsed = CreateLinkSchema.safeParse(response);
    if (
      !parsed.success ||
      parsed.data.orderCode !== orderCode ||
      parsed.data.amount !== amount ||
      !['PENDING', 'UNDERPAID', 'PROCESSING'].includes(parsed.data.status)
    )
      throw new BadGatewayException('Invalid payOS payment response.');
    if (
      this.paymentLinkId(parsed.data.checkoutUrl) !== parsed.data.paymentLinkId
    )
      throw new BadGatewayException(
        'payOS checkout URL does not match the payment link.',
      );
    return parsed.data.checkoutUrl;
  }

  async queryTransaction(merchantReference: string) {
    const client = this.sdk();
    const orderCode = this.orderCode(merchantReference);
    try {
      const response = LinkSchema.parse(
        await client.paymentRequests.get(orderCode),
      );
      if (response.orderCode !== orderCode)
        throw new Error('Order code mismatch');
      return response;
    } catch {
      throw new BadGatewayException('payOS transaction could not be verified.');
    }
  }

  async verifyCallback(raw: unknown) {
    const client = this.sdk();
    const parsed = PayosWebhookDto.schema.safeParse(raw);
    if (!parsed.success)
      throw new BadRequestException('Invalid payOS webhook.');
    try {
      await client.webhooks.verify(parsed.data);
    } catch {
      throw new BadRequestException('Invalid payOS webhook signature.');
    }
    const { orderCode, amount, currency, paymentLinkId, reference, code } =
      parsed.data.data;
    return {
      data: { orderCode, amount, currency, paymentLinkId, reference, code },
      payloadHash: createHash('sha256')
        .update(parsed.data.signature)
        .digest('hex'),
    };
  }

  paymentLinkId(paymentUrl: string) {
    const url = new URL(paymentUrl);
    const match = /^\/web\/([a-f0-9]{32})$/.exec(url.pathname);
    if (
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      url.port ||
      !['pay.payos.vn', 'next.pay.payos.vn'].includes(url.hostname) ||
      !match
    )
      throw new BadGatewayException('Unsafe payOS checkout URL.');
    return match[1];
  }

  verifyReturnState(state: unknown) {
    if (
      typeof state !== 'string' ||
      !/^[a-f0-9-]{36}\.[a-f0-9]{64}$/.test(state)
    )
      return null;
    const [reference] = state.split('.');
    if (!z.uuid().safeParse(reference).success) return null;
    const expected = Buffer.from(this.returnState(reference));
    const received = Buffer.from(state);
    return expected.length === received.length &&
      timingSafeEqual(expected, received)
      ? reference
      : null;
  }

  private returnState(reference: string) {
    const signature = createHmac(
      'sha256',
      this.config.getOrThrow<string>('JWT_SECRET'),
    )
      .update(`payos:return:${reference}`)
      .digest('hex');
    return `${reference}.${signature}`;
  }

  private orderCode(reference: string) {
    const code = Number(reference);
    if (
      !/^\d{10,16}$/.test(reference) ||
      !Number.isSafeInteger(code) ||
      code < 1000000000
    )
      throw new BadRequestException('Invalid payOS order code.');
    return code;
  }

  private sdk() {
    this.assertConfigured();
    return (this.client ??= new PayOS({
      clientId: this.config.getOrThrow<string>('PAYOS_CLIENT_ID'),
      apiKey: this.config.getOrThrow<string>('PAYOS_API_KEY'),
      checksumKey: this.config.getOrThrow<string>('PAYOS_CHECKSUM_KEY'),
      baseURL: 'https://api-merchant.payos.vn',
      timeout: this.config.get<number>('PAYOS_API_TIMEOUT_MS', 5000),
      maxRetries: 0,
      logLevel: 'off',
      fetch: async (url, options) => {
        const response = await fetch(url, options);
        if (response.ok) {
          const body = z
            .object({ code: z.string(), signature: z.string().optional() })
            .parse(await response.clone().json());
          // The SDK verifies a signature only when present; successful financial reads must have one.
          if (
            body.code === '00' &&
            !/^[a-f0-9]{64}$/.test(body.signature ?? '')
          )
            throw new Error('Unsigned payOS response');
        }
        return response;
      },
    }));
  }
}
