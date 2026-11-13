import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { DiscountType, Prisma } from '@prisma/client';
import { Decimal } from '@prisma/client/runtime/library';
import type {
  ExtendedPrismaClient,
  ExtendedPrismaTransactionClient,
} from '../../common/types';
import { PaginationUtilService } from '../../common/utils/pagination-util/pagination-util.service';
import { IdempotencyService } from '../durable/idempotency.service';
import { PromotionCalculatorService } from '../promotions/services/promotion-calculator.service';
import {
  GetCustomerVouchersDto,
  GetVoucherGrantsDto,
  GiftCustomerVoucherDto,
} from './dto/voucher.dto';
import { VouchersService } from './vouchers.service';

const customerId = '11111111-1111-4111-8111-111111111111';
const voucherId = '22222222-2222-4222-8222-222222222222';
const campaignId = '33333333-3333-4333-8333-333333333333';
const requestId = '44444444-4444-4444-8444-444444444444';
const invoiceId = '55555555-5555-4555-8555-555555555555';
const time = new Date('2026-11-10T00:00:00.000Z');

function setup() {
  const campaign = {
    id: campaignId,
    name: 'Voucher',
    description: null,
    isPublic: true,
    status: 'ACTIVE',
    discountType: DiscountType.PERCENTAGE,
    discountValue: new Decimal('10'),
    maxDiscount: new Decimal('50000'),
    minSubtotal: new Decimal('100'),
    startDate: new Date('2020-01-01T00:00:00Z'),
    endDate: new Date('2099-01-01T00:00:00Z'),
    issuanceLimit: 1,
    issuedCount: 0,
    publishedAt: time,
    createdAt: time,
    updatedAt: time,
  };
  const grant = {
    id: voucherId,
    campaignId,
    customerId,
    source: 'CLAIM',
    sourceKey: `CLAIM:${customerId}`,
    sourceOrderId: null,
    issuedById: null,
    reason: 'PRIVATE GIFT REASON',
    revokedAt: null,
    revokedById: null,
    revocationReason: 'PRIVATE REVOKE REASON',
    createdAt: time,
    updatedAt: time,
    campaign,
    redemptions: [] as any[],
  };
  const request = {
    customerId,
    status: 'PENDING',
    expiresAt: campaign.endDate,
    quotedSubtotal: new Decimal('1000'),
    quotedTotal: new Decimal('1000'),
    discountAmount: new Decimal('0'),
    orderSessionId: 'session',
  };
  const tx = {
    $queryRaw: jest.fn().mockResolvedValue([{ id: voucherId }]),
    voucherCampaign: {
      findUnique: jest.fn().mockResolvedValue(campaign),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    customer: { findFirst: jest.fn().mockResolvedValue({ id: customerId }) },
    employee: { findFirst: jest.fn().mockResolvedValue({ id: 'employee' }) },
    actionLog: { create: jest.fn().mockResolvedValue({ id: 'audit' }) },
    customerVoucher: {
      findUnique: jest.fn().mockResolvedValue(null),
      findUniqueOrThrow: jest.fn().mockResolvedValue(grant),
      findFirst: jest.fn().mockResolvedValue(grant),
      create: jest.fn().mockResolvedValue(grant),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      count: jest.fn().mockResolvedValue(1),
      findMany: jest.fn().mockResolvedValue([grant]),
    },
    onlineOrderRequest: {
      findFirst: jest.fn().mockResolvedValue(request),
      findUnique: jest.fn().mockResolvedValue(request),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    voucherRedemption: {
      findUnique: jest.fn().mockResolvedValue(null),
      findMany: jest.fn().mockResolvedValue([]),
      create: jest.fn().mockImplementation(({ data }) => Promise.resolve(data)),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    invoice: {
      findUnique: jest.fn().mockResolvedValue({
        orderSessionId: 'session',
        subTotal: new Decimal('1000'),
        discountAmount: new Decimal('100'),
        totalAmount: new Decimal('900'),
        taxAmount: new Decimal('0'),
        promotionId: null,
        paymentStatus: 'PAID',
      }),
    },
  };
  const prisma = {
    ...tx,
    $transaction: jest.fn().mockImplementation((callback) => callback(tx)),
  };
  const idempotency = {
    execute: jest.fn().mockImplementation((_input, operation) => operation(tx)),
  };
  const service = new VouchersService(
    prisma as unknown as ExtendedPrismaClient,
    new PromotionCalculatorService({} as never, {} as never),
    new PaginationUtilService(),
    idempotency as unknown as IdempotencyService,
  );
  const transaction = tx as unknown as ExtendedPrismaTransactionClient;
  return {
    service,
    tx,
    transaction,
    grant,
    campaign,
    request,
    prisma,
    idempotency,
  };
}

describe('VouchersService issuance and wallet', () => {
  it('reads one staff grant independently of list pagination', async () => {
    const { service, tx, grant } = setup();
    tx.customerVoucher.findUnique.mockResolvedValue(grant);
    expect(await service.getGrant(voucherId)).toMatchObject({
      id: voucherId,
      customerId,
    });
    tx.customerVoucher.findUnique.mockResolvedValue(null);
    await expect(service.getGrant(voucherId)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
  it('conditionally increments the cap and uses the canonical claim source key', async () => {
    const { service, tx, campaign } = setup();
    const result = await service.claim(customerId, campaignId);
    expect(tx.voucherCampaign.updateMany).toHaveBeenCalledWith({
      where: expect.objectContaining({
        status: 'ACTIVE',
        isPublic: true,
        issuedCount: { lt: 1 },
      }),
      data: { issuedCount: { increment: 1 }, updatedAt: campaign.updatedAt },
    });
    expect(tx.customerVoucher.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: {
          campaignId,
          customerId,
          source: 'CLAIM',
          sourceKey: `CLAIM:${customerId}`,
        },
      }),
    );
    expect(result).toEqual({ customerId, voucherId });
    expect(result).not.toHaveProperty('reason');
    expect(result).not.toHaveProperty('revocationReason');
  });

  it('does not create a grant when the conditional issuance cap loses', async () => {
    const { service, tx } = setup();
    tx.voucherCampaign.updateMany.mockResolvedValue({ count: 0 });
    await expect(service.claim(customerId, campaignId)).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(tx.customerVoucher.create).not.toHaveBeenCalled();
  });

  it('replays a claim without consuming quota even if its campaign is paused or full', async () => {
    const { service, tx, grant, campaign } = setup();
    campaign.status = 'PAUSED';
    campaign.issuedCount = 1;
    tx.customerVoucher.findUnique.mockResolvedValue(grant);
    expect((await service.claim(customerId, campaignId)).voucherId).toBe(
      voucherId,
    );
    expect(tx.voucherCampaign.updateMany).not.toHaveBeenCalled();
  });

  it('rejects claims against non-public campaigns and inactive recipients', async () => {
    const { service, campaign, tx } = setup();
    campaign.isPublic = false;
    await expect(service.claim(customerId, campaignId)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    campaign.isPublic = true;
    tx.customer.findFirst.mockResolvedValue(null);
    await expect(service.claim(customerId, campaignId)).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('gifts only to the source order customer through existing durable idempotency', async () => {
    const { service, tx, idempotency } = setup();
    const dto = {
      sourceOrderId: requestId,
      reason: 'Compensation',
      idempotencyKey: 'gift-key-123',
    };
    await service.gift(campaignId, 'employee', dto);
    expect(tx.actionLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          employeeId: 'employee',
          actionType: 'CUSTOMER_VOUCHER_GIFTED',
          details: expect.objectContaining({
            sourceOrderId: requestId,
            reason: dto.reason,
          }),
        }),
      }),
    );
    expect(idempotency.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        employeeId: 'employee',
        operation: 'voucher.gift',
        key: dto.idempotencyKey,
      }),
      expect.any(Function),
    );
    expect(tx.customerVoucher.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: {
          campaignId,
          customerId,
          source: 'GIFT',
          sourceKey: `GIFT:${requestId}`,
          sourceOrderId: requestId,
          issuedById: 'employee',
          reason: dto.reason,
        },
      }),
    );
    expect(
      GiftCustomerVoucherDto.schema.safeParse({ ...dto, customerId }).success,
    ).toBe(false);
  });

  it('rejects gifting an anonymous order', async () => {
    const { service, request, tx } = setup();
    request.customerId = null as any;
    await expect(
      service.gift(campaignId, 'employee', {
        sourceOrderId: requestId,
        reason: 'Compensation',
        idempotencyKey: 'gift-key-123',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(tx.voucherCampaign.updateMany).not.toHaveBeenCalled();
  });

  it('fails the gift transaction when the audit write fails', async () => {
    const { service, tx } = setup();
    tx.actionLog.create.mockRejectedValue(new Error('audit unavailable'));
    await expect(
      service.gift(campaignId, 'employee', {
        sourceOrderId: requestId,
        reason: 'Compensation',
        idempotencyKey: 'gift-key-123',
      }),
    ).rejects.toThrow('audit unavailable');
  });

  it('recovers a concurrent unique-source collision without issuing a second gift', async () => {
    const { service, idempotency, tx, grant } = setup();
    idempotency.execute.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('unique', {
        code: 'P2002',
        clientVersion: '6',
        meta: { target: ['campaignId', 'sourceKey'] },
      }),
    );
    tx.customerVoucher.findUnique.mockResolvedValue(grant);
    expect(
      (
        await service.gift(campaignId, 'employee', {
          sourceOrderId: requestId,
          reason: 'Compensation',
          idempotencyKey: 'gift-key-123',
        })
      ).voucherId,
    ).toBe(voucherId);
    expect(tx.customerVoucher.create).not.toHaveBeenCalled();
  });

  it('filters wallet by authenticated customer, status and request id with stable pagination', async () => {
    const { service, tx } = setup();
    const result = await service.getWallet(
      customerId,
      GetCustomerVouchersDto.schema.parse({
        page: '2',
        itemPerPage: '10',
        status: 'AVAILABLE',
        orderId: requestId,
      }),
    );
    expect(tx.customerVoucher.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          AND: expect.arrayContaining([
            { customerId },
            { redemptions: { some: { onlineOrderRequestId: requestId } } },
          ]),
        },
        skip: 10,
        take: 10,
        orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
      }),
    );
    expect(result).toMatchObject({
      customerId,
      currentPage: 2,
      totalPages: 1,
      totalItems: 1,
    });
    expect(JSON.stringify(result)).not.toContain('PRIVATE');
  });

  it.each(['RESERVED', 'REDEEMED'])(
    'does not revoke a %s grant',
    async (status) => {
      const { service, tx, grant } = setup();
      tx.customerVoucher.findUnique.mockResolvedValue(grant);
      grant.redemptions.push({ status });
      await expect(
        service.revoke(voucherId, 'employee', {
          reason: 'Mistake',
          expectedUpdatedAt: time,
          idempotencyKey: 'revoke-key-123',
        }),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(tx.customerVoucher.updateMany).not.toHaveBeenCalled();
    },
  );

  it('exposes gift recovery identifiers and reason only in the staff grants list', async () => {
    const { service, grant, tx } = setup();
    grant.sourceOrderId = requestId as any;
    const staff = await service.getGrants(
      campaignId,
      GetVoucherGrantsDto.schema.parse({ sourceOrderId: requestId }),
    );
    expect(staff.list[0]).toMatchObject({
      customerId,
      sourceOrderId: requestId,
      reason: 'PRIVATE GIFT REASON',
    });
    expect(tx.customerVoucher.findMany).toHaveBeenLastCalledWith(
      expect.objectContaining({
        where: {
          AND: [
            { campaignId, source: undefined, sourceOrderId: requestId },
            {},
          ],
        },
      }),
    );
    const wallet = await service.getWallet(
      customerId,
      GetCustomerVouchersDto.schema.parse({}),
    );
    expect(wallet.list[0]).not.toHaveProperty('reason');
    expect(wallet.list[0]).not.toHaveProperty('customerId');
    expect(wallet.list[0]).not.toHaveProperty('sourceOrderId');
  });

  it('revokes once and preserves the first internal reason on replay', async () => {
    const { service, tx, grant } = setup();
    tx.customerVoucher.findUnique.mockResolvedValue(grant);
    const dto = {
      reason: 'Mistake',
      expectedUpdatedAt: time,
      idempotencyKey: 'revoke-key-123',
    };
    await service.revoke(voucherId, 'employee', dto);
    expect(tx.customerVoucher.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          revokedById: 'employee',
          revocationReason: 'Mistake',
        }),
      }),
    );
    grant.revokedAt = time as any;
    tx.customerVoucher.updateMany.mockClear();
    const replay = await service.revoke(voucherId, 'employee', {
      ...dto,
      reason: 'Replacement',
    });
    expect(tx.customerVoucher.updateMany).not.toHaveBeenCalled();
    expect(replay).not.toHaveProperty('revocationReason');
  });
});

describe('VouchersService financial lifecycle', () => {
  const input = { customerId, voucherId, subTotal: '1000.00' };

  it('quotes exact decimal strings with no customer or internal metadata', async () => {
    const { service, transaction } = setup();
    expect(await service.quoteInTransaction(transaction, input)).toEqual({
      voucherId,
      campaignId,
      name: 'Voucher',
      discountType: 'PERCENTAGE',
      discountValue: '10.00',
      maxDiscount: '50000.00',
      minSubtotal: '100.00',
      startDate: '2020-01-01T00:00:00.000Z',
      endDate: '2099-01-01T00:00:00.000Z',
      discountAmount: '100.00',
      totalAmount: '900.00',
    });
  });

  it('keeps full monetary precision above the safe JavaScript integer range', async () => {
    const { service, transaction } = setup();
    const result = await service.quoteInTransaction(transaction, {
      ...input,
      subTotal: '9999999999999999.99',
    });
    expect(result.discountAmount).toBe('50000.00');
    expect(result.totalAmount).toBe('9999999999949999.99');
  });

  it('allows redemption terms for paused campaigns', async () => {
    const { service, transaction, campaign } = setup();
    campaign.status = 'PAUSED';
    expect(
      (await service.quoteInTransaction(transaction, input)).totalAmount,
    ).toBe('900.00');
  });

  it.each(['0', '-1', '1.001', 'NaN', 'Infinity', '10000000000000000.00'])(
    'rejects invalid subtotal %s',
    async (subTotal) => {
      const { service, transaction } = setup();
      await expect(
        service.quoteInTransaction(transaction, { ...input, subTotal }),
      ).rejects.toBeInstanceOf(BadRequestException);
    },
  );

  it('does not expose ownership for another customer', async () => {
    const { service, transaction, tx } = setup();
    tx.customerVoucher.findFirst.mockResolvedValue(null);
    await expect(
      service.quoteInTransaction(transaction, input),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(tx.customerVoucher.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: voucherId, customerId } }),
    );
    expect(tx.voucherRedemption.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          customerVoucherId: voucherId,
          customerVoucher: { customerId },
        }),
      }),
    );
    expect(tx.voucherRedemption.updateMany).not.toHaveBeenCalled();
  });

  it.each([
    [
      'REVOKED',
      (context: ReturnType<typeof setup>) => {
        context.grant.revokedAt = time as any;
      },
    ],
    [
      'USED',
      (context: ReturnType<typeof setup>) => {
        context.grant.redemptions.push({ status: 'REDEEMED' });
      },
    ],
    [
      'RESERVED',
      (context: ReturnType<typeof setup>) => {
        context.grant.redemptions.push({ status: 'RESERVED' });
      },
    ],
    [
      'EXPIRED',
      (context: ReturnType<typeof setup>) => {
        context.campaign.endDate = new Date(0);
      },
    ],
    [
      'NOT_ACTIVE',
      (context: ReturnType<typeof setup>) => {
        context.campaign.startDate = new Date('2098-01-01T00:00:00Z');
      },
    ],
    [
      'MIN_SUBTOTAL',
      (context: ReturnType<typeof setup>) => {
        context.campaign.minSubtotal = new Decimal('1001');
      },
    ],
  ] as const)(
    'returns a stable VOUCHER_%s eligibility code without internal metadata',
    async (code, change) => {
      const context = setup();
      change(context);
      await expect(
        context.service.quoteInTransaction(context.transaction, input),
      ).rejects.toMatchObject({
        response: { code: `VOUCHER_${code}`, message: expect.any(String) },
      });
    },
  );

  it('rejects a zero total even if invalid campaign terms reached storage', async () => {
    const { service, transaction, campaign } = setup();
    campaign.discountType = DiscountType.FIXED_AMOUNT as any;
    campaign.discountValue = new Decimal('1000');
    await expect(
      service.quoteInTransaction(transaction, input),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('reserves the exact snapshot and owns repricing the undiscounted request', async () => {
    const { service, transaction, tx } = setup();
    const result = await service.reserveInTransaction(transaction, {
      ...input,
      onlineOrderRequestId: requestId,
    });
    expect(tx.onlineOrderRequest.updateMany).toHaveBeenCalledWith({
      where: {
        id: requestId,
        customerId,
        status: 'PENDING',
        expiresAt: { gt: expect.any(Date) },
        quotedSubtotal: new Decimal('1000'),
        discountAmount: 0,
        quotedTotal: new Decimal('1000'),
      },
      data: { discountAmount: '100.00', quotedTotal: '900.00' },
    });
    expect(tx.voucherRedemption.create).toHaveBeenCalledWith({
      data: {
        customerVoucherId: voucherId,
        onlineOrderRequestId: requestId,
        status: 'RESERVED',
        subTotal: new Decimal('1000'),
        discountAmount: '100.00',
        totalAmount: '900.00',
        discountSnapshot: result,
      },
    });
  });

  it('rejects a stored order net total mismatch', async () => {
    const { service, transaction, request, tx } = setup();
    request.quotedTotal = new Decimal('999');
    await expect(
      service.reserveInTransaction(transaction, {
        ...input,
        onlineOrderRequestId: requestId,
      }),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(tx.voucherRedemption.create).not.toHaveBeenCalled();
  });

  it('does not create a hold if the conditional request repricing loses', async () => {
    const { service, transaction, tx } = setup();
    tx.onlineOrderRequest.updateMany.mockResolvedValue({ count: 0 });
    await expect(
      service.reserveInTransaction(transaction, {
        ...input,
        onlineOrderRequestId: requestId,
      }),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(tx.voucherRedemption.create).not.toHaveBeenCalled();
  });

  it('replays the original snapshot instead of recalculating edited display terms', async () => {
    const { service, transaction, tx, campaign } = setup();
    const snapshot = await service.quoteInTransaction(transaction, input);
    tx.voucherRedemption.findUnique.mockResolvedValue({
      customerVoucherId: voucherId,
      customerVoucher: { customerId },
      subTotal: new Decimal('1000'),
      status: 'RESERVED',
      discountSnapshot: snapshot,
    });
    campaign.name = 'Changed';
    expect(
      await service.reserveInTransaction(transaction, {
        ...input,
        onlineOrderRequestId: requestId,
      }),
    ).toEqual(snapshot);
    expect(tx.voucherRedemption.create).not.toHaveBeenCalled();
  });

  it('does not reuse a released reservation for the same request', async () => {
    const { service, transaction, tx } = setup();
    tx.voucherRedemption.findUnique.mockResolvedValue({
      customerVoucherId: voucherId,
      customerVoucher: { customerId },
      subTotal: new Decimal('1000'),
      status: 'RELEASED',
    });
    await expect(
      service.reserveInTransaction(transaction, {
        ...input,
        onlineOrderRequestId: requestId,
      }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  function reserved() {
    const context = setup();
    context.request.status = 'ACCEPTED';
    const row = {
      id: 'redemption',
      customerVoucherId: voucherId,
      customerVoucher: { customerId },
      status: 'RESERVED',
      invoiceId: null as string | null,
      subTotal: new Decimal('1000'),
      discountAmount: new Decimal('100'),
      totalAmount: new Decimal('900'),
    };
    context.tx.voucherRedemption.findUnique.mockResolvedValue(row);
    return { ...context, row };
  }

  it('redeems once with the exact accepted order invoice', async () => {
    const { service, transaction, tx, row } = reserved();
    await expect(
      service.redeemInTransaction(transaction, requestId, invoiceId),
    ).resolves.toMatchObject({ status: 'REDEEMED', invoiceId });
    expect(tx.voucherRedemption.updateMany).toHaveBeenCalledWith({
      where: { id: 'redemption', status: 'RESERVED', invoiceId: null },
      data: { status: 'REDEEMED', invoiceId, redeemedAt: expect.any(Date) },
    });
    row.status = 'REDEEMED';
    row.invoiceId = invoiceId;
    tx.voucherRedemption.updateMany.mockClear();
    await service.redeemInTransaction(transaction, requestId, invoiceId);
    expect(tx.voucherRedemption.updateMany).not.toHaveBeenCalled();
    await expect(
      service.redeemInTransaction(transaction, requestId, 'other'),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it.each([
    { subTotal: new Decimal('1001') },
    { discountAmount: new Decimal('99') },
    { totalAmount: new Decimal('1000') },
    { taxAmount: new Decimal('10') },
    { orderSessionId: 'other' },
    { promotionId: 'promotion' },
    { paymentStatus: 'UNPAID' },
  ])('rejects an invoice mismatch %j', async (patch) => {
    const { service, transaction, tx } = reserved();
    const invoice = await tx.invoice.findUnique();
    tx.invoice.findUnique.mockResolvedValue({ ...invoice, ...patch });
    await expect(
      service.redeemInTransaction(transaction, requestId, invoiceId),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(tx.voucherRedemption.updateMany).not.toHaveBeenCalled();
  });

  it('never releases an accepted request', async () => {
    const { service, transaction, tx } = reserved();
    await expect(
      service.releaseInTransaction(transaction, requestId, 'REQUEST_EXPIRED'),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(tx.voucherRedemption.updateMany).not.toHaveBeenCalled();
  });

  it('requires a PAID invoice before the redemption transition', async () => {
    const { service, transaction, tx } = reserved();
    const invoice = await tx.invoice.findUnique();
    tx.invoice.findUnique.mockResolvedValue({
      ...invoice,
      paymentStatus: 'UNPAID',
    });
    await expect(
      service.redeemInTransaction(transaction, requestId, invoiceId),
    ).rejects.toMatchObject({
      response: {
        code: 'VOUCHER_INVOICE_NOT_PAID',
        message: 'Invoice must be paid before voucher redemption.',
      },
    });
    expect(tx.invoice.findUnique).toHaveBeenLastCalledWith(
      expect.objectContaining({
        select: expect.objectContaining({ paymentStatus: true }),
      }),
    );
    expect(tx.voucherRedemption.updateMany).not.toHaveBeenCalled();
  });

  it('releases only RESERVED rows and stores the internal reason without returning it', async () => {
    const { service, transaction, tx } = setup();
    expect(
      await service.releaseInTransaction(
        transaction,
        requestId,
        'REQUEST_CANCELLED',
      ),
    ).toEqual({ released: true });
    expect(tx.voucherRedemption.updateMany).toHaveBeenCalledWith({
      where: { onlineOrderRequestId: requestId, status: 'RESERVED' },
      data: {
        status: 'RELEASED',
        releasedAt: expect.any(Date),
        releaseReason: 'REQUEST_CANCELLED',
      },
    });
  });

  it('locks and rechecks expired PENDING requests in a bounded cleanup batch', async () => {
    const { service, tx } = setup();
    tx.voucherRedemption.findMany.mockResolvedValue([
      { onlineOrderRequestId: requestId },
    ]);
    expect(await service.releaseExpiredReservations()).toEqual({ released: 1 });
    expect(tx.voucherRedemption.findMany).toHaveBeenCalledWith({
      where: {
        status: 'RESERVED',
        onlineOrderRequest: {
          status: 'PENDING',
          expiresAt: { lte: expect.any(Date) },
        },
      },
      select: { onlineOrderRequestId: true },
      orderBy: { onlineOrderRequestId: 'asc' },
      take: 100,
    });
    expect(tx.$queryRaw).toHaveBeenCalled();
    expect(tx.voucherRedemption.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          onlineOrderRequestId: requestId,
          status: 'RESERVED',
          onlineOrderRequest: {
            status: 'PENDING',
            expiresAt: { lte: expect.any(Date) },
          },
        },
      }),
    );
  });

  it('does not release if the request was accepted between selection and the locked recheck', async () => {
    const { service, tx } = setup();
    tx.voucherRedemption.findMany.mockResolvedValue([
      { onlineOrderRequestId: requestId },
    ]);
    tx.voucherRedemption.updateMany.mockResolvedValue({ count: 0 });
    expect(await service.releaseExpiredReservations()).toEqual({ released: 0 });
  });

  it('lazily releases an expired hold before reserving the grant on a new request', async () => {
    const { service, transaction, tx } = setup();
    tx.voucherRedemption.findMany.mockResolvedValue([
      { onlineOrderRequestId: 'old-expired-request' },
    ]);
    await service.reserveInTransaction(transaction, {
      ...input,
      onlineOrderRequestId: requestId,
    });
    expect(
      tx.voucherRedemption.updateMany.mock.invocationCallOrder[0],
    ).toBeLessThan(tx.voucherRedemption.create.mock.invocationCallOrder[0]);
  });
});
