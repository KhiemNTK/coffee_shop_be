import { createHmac } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import {
  BadGatewayException,
  BadRequestException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { PayOS } from '@payos/node';
import { Prisma } from '@prisma/client';
import { PayosService } from './payos.service';

describe('PayosService with the official SDK', () => {
  const checksumKey = 'fixture-checksum-key-not-a-real-credential';
  const jwtSecret = 'fixture-return-secret-not-a-real-credential';
  const config = new ConfigService({
    PAYOS_CLIENT_ID: 'fixture-client-id-not-a-real-credential',
    PAYOS_API_KEY: 'fixture-api-key-not-a-real-credential',
    PAYOS_CHECKSUM_KEY: checksumKey,
    PAYOS_RETURN_URL: 'https://shop.example.test/payment/payos/return',
    JWT_SECRET: jwtSecret,
  });
  const signer = new PayOS({
    clientId: 'fixture',
    apiKey: 'fixture',
    checksumKey,
    logLevel: 'off',
  });
  const linkId = 'a'.repeat(32);
  const orderCode = 1000000000;
  const paymentAttemptId = '70000000-0000-4000-8000-000000000001';
  const createResponse = {
    paymentLinkId: linkId,
    orderCode,
    amount: 35000,
    currency: 'VND',
    status: 'PENDING',
    checkoutUrl: `https://pay.payos.vn/web/${linkId}`,
  };
  const link = {
    id: linkId,
    orderCode,
    amount: 35000,
    amountPaid: 0,
    amountRemaining: 35000,
    status: 'PENDING',
    transactions: [],
  };
  const input = {
    paymentAttemptId,
    amount: new Prisma.Decimal(35000),
    merchantReference: String(orderCode),
    expiresAt: new Date(Date.now() + 900000),
  };
  const signedResponse = async (data: Record<string, unknown>) =>
    Response.json({
      code: '00',
      data,
      signature: await signer.crypto.createSignatureFromObj(data, checksumKey),
    });
  const webhook = async () => {
    const data = {
      orderCode,
      amount: 35000,
      currency: 'VND',
      paymentLinkId: linkId,
      reference: 'BANK-1',
      code: '00',
      desc: 'success',
      description: 'Coffee',
      accountNumber: 'private-bank-account',
      transactionDateTime: '2026-10-12 12:00:00',
      counterAccountName: 'private-customer-name',
    };
    return {
      code: '00',
      desc: 'success',
      success: true,
      data,
      signature: await signer.crypto.createSignatureFromObj(data, checksumKey),
    };
  };
  afterEach(() => jest.restoreAllMocks());

  it('is disabled without credentials and never probes the provider', () => {
    const fetchSpy = jest.spyOn(globalThis, 'fetch');
    expect(() =>
      new PayosService(new ConfigService()).assertConfigured(),
    ).toThrow(ServiceUnavailableException);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it.each(['0', '-1', '1.5', '9007199254740992'])(
    'rejects unsafe VND amount %s',
    (amount) => {
      expect(() =>
        new PayosService(config).assertAmount(new Prisma.Decimal(amount)),
      ).toThrow(BadRequestException);
    },
  );

  it('signs creation, fixes the destination URL, and rejects unsafe links', async () => {
    const fetchSpy = jest
      .spyOn(globalThis, 'fetch')
      .mockImplementation(() => signedResponse(createResponse));
    const service = new PayosService(config);
    expect(await service.createPaymentUrl(input)).toBe(
      createResponse.checkoutUrl,
    );
    const body = fetchSpy.mock.calls[0][1]?.body;
    if (typeof body !== 'string')
      throw new Error('Expected a JSON request body');
    const request = JSON.parse(body) as Record<string, unknown>;
    expect(fetchSpy.mock.calls[0][0]).toBe(
      'https://api-merchant.payos.vn/v2/payment-requests',
    );
    expect(request.signature).toBe(
      await signer.crypto.createSignatureOfPaymentRequest(request, checksumKey),
    );
    expect(request.returnUrl).toBe(request.cancelUrl);
    const state = new URL(String(request.returnUrl)).searchParams.get('state');
    expect(service.verifyReturnState(state)).toBe(paymentAttemptId);
    expect(
      service.verifyReturnState(String(state).replace(/^7/, '8')),
    ).toBeNull();
    expect(() =>
      service.paymentLinkId(`https://evil.example/web/${linkId}`),
    ).toThrow(BadGatewayException);
  });

  it.each(['lost', 'duplicate'])(
    'recovers a %s creation response without allocating another order code',
    async (scenario) => {
      const fetchSpy = jest.spyOn(globalThis, 'fetch');
      if (scenario === 'lost')
        fetchSpy.mockRejectedValueOnce(new Error('connection interrupted'));
      else
        fetchSpy.mockResolvedValueOnce(
          Response.json({ code: '201', desc: 'already exists' }),
        );
      fetchSpy.mockImplementationOnce(() => signedResponse(link));
      expect(await new PayosService(config).createPaymentUrl(input)).toBe(
        createResponse.checkoutUrl,
      );
      expect(fetchSpy).toHaveBeenCalledTimes(2);
      expect(fetchSpy.mock.calls[1][0]).toBe(
        `https://api-merchant.payos.vn/v2/payment-requests/${orderCode}`,
      );
    },
  );

  it.each(['missing', 'forged'])(
    'rejects a %s financial response signature',
    async (kind) => {
      jest.spyOn(globalThis, 'fetch').mockResolvedValue(
        Response.json({
          code: '00',
          data: link,
          ...(kind === 'forged' ? { signature: '0'.repeat(64) } : {}),
        }),
      );
      await expect(
        new PayosService(config).queryTransaction(String(orderCode)),
      ).rejects.toBeInstanceOf(BadGatewayException);
    },
  );

  it('verifies every signed webhook field but does not trust unsigned status or retain bank PII', async () => {
    const payload = await webhook();
    const result = await new PayosService(config).verifyCallback({
      ...payload,
      success: false,
    });
    expect(result.data).toEqual({
      orderCode,
      amount: 35000,
      currency: 'VND',
      paymentLinkId: linkId,
      reference: 'BANK-1',
      code: '00',
    });
    expect(JSON.stringify(result)).not.toContain('private-');
    await expect(
      new PayosService(config).verifyCallback({
        ...payload,
        data: { ...payload.data, amount: 1 },
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('requires a server-issued return token; an order code alone proves nothing', () => {
    const service = new PayosService(config);
    const state = `${paymentAttemptId}.${createHmac('sha256', jwtSecret).update(`payos:return:${paymentAttemptId}`).digest('hex')}`;
    expect(service.verifyReturnState(state)).toBe(paymentAttemptId);
    expect(service.verifyReturnState(String(orderCode))).toBeNull();
    expect(service.verifyReturnState([state])).toBeNull();
    expect(
      service.verifyReturnState(`${orderCode}.${'0'.repeat(64)}`),
    ).toBeNull();
  });
});
