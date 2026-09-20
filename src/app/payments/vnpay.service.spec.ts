import { ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import { VnpayService } from './vnpay.service';

describe('VnpayService', () => {
  const config = new ConfigService({
    VNPAY_TMN_CODE: 'COFFEE01',
    VNPAY_HASH_SECRET: 'sandbox-secret-123456789',
    VNPAY_PAYMENT_URL: 'https://sandbox.vnpayment.vn/paymentv2/vpcpay.html',
    VNPAY_RETURN_URL: 'https://coffee.example.com/payment/vnpay/return',
  });
  const service = new VnpayService(config);

  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('builds the VNPay 2.1.0 HMAC-SHA512 contract deterministically', () => {
    const paymentUrl = service.createPaymentUrl({
      amount: new Prisma.Decimal('125500'),
      invoiceNumber: 'INV-001',
      merchantReference: 'PA123',
      ipAddress: '127.0.0.1',
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
});
