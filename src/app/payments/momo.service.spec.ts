import { createHmac } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import { MomoService } from './momo.service';

const secret = 'momo-secret-for-sandbox-tests-123456';
const sign = (fields: Record<string, string>) =>
  createHmac('sha256', secret)
    .update(
      Object.entries(fields)
        .map(([key, value]) => `${key}=${value}`)
        .join('&'),
    )
    .digest('hex');

describe('MomoService', () => {
  const service = new MomoService(
    new ConfigService({
      MOMO_PARTNER_CODE: 'TESTSHOP',
      MOMO_ACCESS_KEY: 'access-key',
      MOMO_SECRET_KEY: secret,
      MOMO_API_URL: 'https://test-payment.momo.vn',
      MOMO_REDIRECT_URL: 'https://shop.example.com/payment/momo/return',
      MOMO_IPN_URL: 'https://api.example.com/api/v1/payments/momo/ipn',
      MOMO_API_TIMEOUT_MS: 30_000,
    }),
  );

  afterEach(() => jest.restoreAllMocks());

  it('signs create request, checks signed gateway response and returns payUrl', async () => {
    const payUrl = 'https://test-payment.momo.vn/v2/gateway/pay?test=1';
    const response = {
      partnerCode: 'TESTSHOP',
      orderId: 'PA123',
      requestId: 'PA123',
      amount: 100000,
      message: 'Successful.',
      resultCode: 0,
      payUrl,
      responseTime: 123456,
    };
    const fetchMock = jest.spyOn(global, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          ...response,
          signature: sign({
            accessKey: 'access-key',
            amount: '100000',
            message: response.message,
            orderId: 'PA123',
            partnerCode: 'TESTSHOP',
            payUrl,
            requestId: 'PA123',
            responseTime: '123456',
            resultCode: '0',
          }),
        }),
        { status: 200 },
      ),
    );

    await expect(
      service.createPaymentUrl({
        merchantReference: 'PA123',
        invoiceNumber: 'INV-001',
        amount: new Prisma.Decimal(100000),
      }),
    ).resolves.toBe(payUrl);
    const body = JSON.parse(
      fetchMock.mock.calls[0][1]?.body as string,
    ) as Record<string, string>;
    expect(body.signature).toBe(
      sign({
        accessKey: 'access-key',
        amount: '100000',
        extraData: '',
        ipnUrl: 'https://api.example.com/api/v1/payments/momo/ipn',
        orderId: 'PA123',
        orderInfo: 'Thanh toan hoa don INV-001',
        partnerCode: 'TESTSHOP',
        redirectUrl: 'https://shop.example.com/payment/momo/return',
        requestId: 'PA123',
        requestType: 'captureWallet',
      }),
    );
  });

  it('rejects forged and mismatched callbacks', () => {
    const fields = {
      accessKey: 'access-key',
      amount: '100000',
      extraData: '',
      message: 'Successful.',
      orderId: 'PA123',
      orderInfo: 'Thanh toan hoa don INV-001',
      orderType: 'momo_wallet',
      partnerCode: 'TESTSHOP',
      payType: 'qr',
      requestId: 'PA123',
      responseTime: '123456',
      resultCode: '0',
      transId: '987654321',
    };
    const notification = {
      ...fields,
      amount: 100000,
      responseTime: 123456,
      resultCode: 0,
      transId: 987654321,
      signature: sign(fields),
    };
    expect(service.verifyCallback(notification)?.data.orderId).toBe('PA123');
    expect(
      service.verifyCallback({ ...notification, amount: 100001 }),
    ).toBeNull();
    expect(
      service.verifyCallback({ ...notification, requestId: 'other' }),
    ).toBeNull();
  });

  it('rejects cross-order query responses', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          partnerCode: 'TESTSHOP',
          orderId: 'OTHER',
          requestId: 'QUERY1',
          resultCode: 0,
          amount: 100000,
          transId: 987654321,
          message: 'Successful.',
        }),
        { status: 200 },
      ),
    );
    await expect(
      service.queryTransaction({
        requestId: 'QUERY1',
        merchantReference: 'PA123',
      }),
    ).rejects.toThrow('Invalid MoMo transaction response');
  });
});
