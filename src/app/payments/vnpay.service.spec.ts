import { createHmac } from 'node:crypto';
import {
  BadGatewayException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import { VnpayService } from './vnpay.service';

describe('VnpayService', () => {
  const hashSecret = 'sandbox-secret-123456789';
  const config = new ConfigService({
    VNPAY_TMN_CODE: 'COFFEE01',
    VNPAY_HASH_SECRET: hashSecret,
    VNPAY_PAYMENT_URL: 'https://sandbox.vnpayment.vn/paymentv2/vpcpay.html',
    VNPAY_API_URL:
      'https://sandbox.vnpayment.vn/merchant_webapi/api/transaction',
    VNPAY_SERVER_IP: '127.0.0.1',
    VNPAY_API_TIMEOUT_MS: 5000,
    VNPAY_RETURN_URL: 'https://coffee.example.com/payment/vnpay/return',
  });
  const service = new VnpayService(config);

  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
  });

  afterEach(() => {
    jest.restoreAllMocks();
    jest.useRealTimers();
  });

  it('builds the VNPay 2.1.0 HMAC-SHA512 contract deterministically', () => {
    const paymentUrl = service.createPaymentUrl({
      amount: new Prisma.Decimal('125500'),
      invoiceNumber: 'INV-001',
      merchantReference: 'PA123',
      ipAddress: '127.0.0.1',
      providerCreatedAt: new Date('2026-01-01T00:00:00.000Z'),
      expiresAt: new Date('2026-01-01T00:15:00.000Z'),
      locale: 'vn',
    });
    const url = new URL(paymentUrl);

    expect(url.searchParams.get('vnp_Version')).toBe('2.1.0');
    expect(url.searchParams.get('vnp_Amount')).toBe('12550000');
    expect(url.searchParams.get('vnp_CreateDate')).toBe('20260101070000');
    expect(url.searchParams.get('vnp_ExpireDate')).toBe('20260101071500');
    expect(url.searchParams.get('vnp_SecureHash')).toBe(
      '642f1b3a341935e8f87abe039f2cc021e204b9013d80b67dcad4395855109bd9c9b79e71682ee48526e923614bf9c2bab3e5211ed3d79eaed6a4e90d5600f526',
    );
  });

  it('accepts a signed callback and rejects tampered or duplicate parameters', () => {
    const url = new URL(
      service.createPaymentUrl({
        amount: new Prisma.Decimal('125500'),
        invoiceNumber: 'INV-001',
        merchantReference: 'PA123',
        ipAddress: '127.0.0.1',
        providerCreatedAt: new Date('2026-01-01T00:00:00.000Z'),
        expiresAt: new Date('2026-01-01T00:15:00.000Z'),
        locale: 'vn',
      }),
    );
    const query = Object.fromEntries(url.searchParams.entries());

    expect(service.verifyCallback(query).isValid).toBe(true);
    expect(
      service.verifyCallback({ ...query, vnp_Amount: '12550001' }).isValid,
    ).toBe(false);
    expect(
      service.verifyCallback({ ...query, vnp_Amount: ['12550000', '1'] })
        .isValid,
    ).toBe(false);
  });

  it('fails before creating attempts when VNPay is not configured', () => {
    const unconfigured = new VnpayService({
      get: () => undefined,
    } as unknown as ConfigService);

    expect(() => unconfigured.assertConfigured()).toThrow(
      ServiceUnavailableException,
    );
  });

  it('signs QueryDr in provider field order and verifies the response', async () => {
    const response = {
      vnp_ResponseId: 'response-1',
      vnp_Command: 'querydr',
      vnp_ResponseCode: '00',
      vnp_Message: 'Success',
      vnp_TmnCode: 'COFFEE01',
      vnp_TxnRef: 'PA123',
      vnp_Amount: '12550000',
      vnp_BankCode: 'NCB',
      vnp_PayDate: '20260101070500',
      vnp_TransactionNo: 'VNP-001',
      vnp_TransactionType: '01',
      vnp_TransactionStatus: '00',
      vnp_OrderInfo: 'Query invoice INV-001',
      vnp_PromotionCode: '',
      vnp_PromotionAmount: '0',
    };
    const responseFields = [
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
    ];
    const fetchMock = jest.spyOn(global, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          ...response,
          vnp_SecureHash: signFields(response, responseFields, hashSecret),
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );

    const result = await service.queryTransaction({
      requestId: 'request-1',
      merchantReference: 'PA123',
      providerCreatedAt: new Date('2026-01-01T00:00:00.000Z'),
      orderInfo: 'Query invoice INV-001',
    });

    const body = fetchMock.mock.calls[0]?.[1]?.body;
    if (typeof body !== 'string') throw new Error('Expected JSON request body');
    const request = JSON.parse(body) as Record<string, string>;
    expect(request.vnp_TransactionDate).toBe('20260101070000');
    expect(request.vnp_SecureHash).toBe(
      signFields(
        request,
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
        hashSecret,
      ),
    );
    expect(result.response).toEqual(response);
  });

  it('rejects an unsigned reconciliation response', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          vnp_ResponseCode: '00',
          vnp_TransactionStatus: '00',
          vnp_SecureHash: 'invalid',
        }),
        { status: 200 },
      ),
    );

    await expect(
      service.queryTransaction({
        requestId: 'request-1',
        merchantReference: 'PA123',
        providerCreatedAt: new Date('2026-01-01T00:00:00.000Z'),
        orderInfo: 'Query invoice INV-001',
      }),
    ).rejects.toBeInstanceOf(BadGatewayException);
  });

  it('uses the VNPay refund transaction type and amount contract', async () => {
    const response = {
      vnp_ResponseId: 'response-2',
      vnp_Command: 'refund',
      vnp_ResponseCode: '00',
      vnp_Message: 'Success',
      vnp_TmnCode: 'COFFEE01',
      vnp_TxnRef: 'PA123',
      vnp_Amount: '5000000',
      vnp_BankCode: 'NCB',
      vnp_PayDate: '20260101070500',
      vnp_TransactionNo: 'VNP-REFUND-1',
      vnp_TransactionType: '03',
      vnp_TransactionStatus: '00',
      vnp_OrderInfo: 'Refund invoice INV-001',
    };
    const fields = [
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
    ];
    const fetchMock = jest.spyOn(global, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          ...response,
          vnp_SecureHash: signFields(response, fields, hashSecret),
        }),
        { status: 200 },
      ),
    );

    await service.refundTransaction({
      requestId: 'request-2',
      merchantReference: 'PA123',
      providerTransactionNo: 'VNP-PAYMENT-1',
      providerCreatedAt: new Date('2026-01-01T00:00:00.000Z'),
      orderInfo: 'Refund invoice INV-001',
      amount: new Prisma.Decimal('50000'),
      createdBy: 'Manager',
      transactionType: '03',
    });

    const body = fetchMock.mock.calls[0]?.[1]?.body;
    if (typeof body !== 'string') throw new Error('Expected JSON request body');
    const request = JSON.parse(body) as Record<string, string>;
    expect(request.vnp_Amount).toBe('5000000');
    expect(request.vnp_TransactionType).toBe('03');
    expect(request.vnp_TransactionNo).toBe('VNP-PAYMENT-1');
  });
});

function signFields(
  params: Record<string, string>,
  fields: string[],
  secret: string,
) {
  return createHmac('sha512', secret)
    .update(fields.map((field) => params[field] ?? '').join('|'))
    .digest('hex');
}
