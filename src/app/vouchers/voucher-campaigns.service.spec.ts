import {
  BadRequestException,
  ConflictException,
  UnauthorizedException,
} from '@nestjs/common';
import { Decimal } from '@prisma/client/runtime/library';
import type { ExtendedPrismaClient } from '../../common/types';
import { PaginationUtilService } from '../../common/utils/pagination-util/pagination-util.service';
import {
  CreateVoucherCampaignDto,
  GetPublicVoucherCampaignsDto,
} from './dto/voucher.dto';
import { VoucherCampaignsService } from './voucher-campaigns.service';

const campaignId = '33333333-3333-4333-8333-333333333333';
const time = new Date('2026-11-10T00:00:00Z');

function setup() {
  const dto = CreateVoucherCampaignDto.schema.parse({
    name: 'Campaign',
    description: null,
    isPublic: true,
    discountType: 'PERCENTAGE',
    discountValue: '10',
    maxDiscount: '100',
    minSubtotal: '100',
    issuanceLimit: 10,
    startDate: '2020-01-01T00:00:00Z',
    endDate: '2099-01-01T00:00:00Z',
  });
  const campaign = {
    ...dto,
    id: campaignId,
    status: 'DRAFT',
    issuedCount: 0,
    discountValue: new Decimal('10'),
    maxDiscount: new Decimal('100'),
    minSubtotal: new Decimal('100'),
    createdAt: time,
    updatedAt: time,
    publishedAt: null as Date | null,
  };
  const tx = {
    employee: { findFirst: jest.fn().mockResolvedValue({ id: 'employee' }) },
    actionLog: { create: jest.fn().mockResolvedValue({}) },
    customerVoucher: { count: jest.fn().mockResolvedValue(2) },
    voucherRedemption: { count: jest.fn().mockResolvedValue(1) },
    voucherCampaign: {
      fields: { issuanceLimit: { field: 'issuanceLimit' } },
      create: jest.fn().mockResolvedValue(campaign),
      findUnique: jest.fn().mockResolvedValue(campaign),
      findUniqueOrThrow: jest.fn().mockResolvedValue(campaign),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      count: jest.fn().mockResolvedValue(1),
      findMany: jest.fn().mockResolvedValue([campaign]),
    },
  };
  const prisma = {
    ...tx,
    $transaction: jest.fn().mockImplementation((operation) => operation(tx)),
  };
  const service = new VoucherCampaignsService(
    prisma as unknown as ExtendedPrismaClient,
    new PaginationUtilService(),
  );
  return { service, tx, prisma, campaign, dto };
}

describe('VoucherCampaignsService', () => {
  it('returns the staff detail counters from one consistent transaction', async () => {
    const { service, tx } = setup();
    expect((await service.findOne(campaignId)).stats).toEqual({
      claimed: 2,
      gifted: 2,
      reserved: 1,
      redeemed: 1,
      revoked: 2,
    });
    expect(tx.voucherRedemption.count).toHaveBeenCalledWith({
      where: { customerVoucher: { campaignId }, status: 'REDEEMED' },
    });
  });
  it('creates only drafts and records the active route actor in the same transaction', async () => {
    const { service, tx, dto, prisma } = setup();
    await service.create('employee', dto);
    expect(prisma.$transaction).toHaveBeenCalled();
    expect(tx.voucherCampaign.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ status: 'DRAFT', issuedCount: 0 }),
    });
    expect(tx.actionLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        employeeId: 'employee',
        actionType: 'VOUCHER_CAMPAIGN_CREATED',
      }),
    });
  });

  it.each([
    { discountValue: '100' },
    { maxDiscount: null },
    { discountValue: '0' },
    { minSubtotal: '0' },
    { maxDiscount: '0' },
    { discountType: 'FIXED_AMOUNT', discountValue: '100' },
    { discountType: 'FIXED_AMOUNT', discountValue: '101' },
    { endDate: new Date('2019-01-01T00:00:00Z') },
  ])('rejects invalid financial/date terms %j before writing', (patch) => {
    const { service, dto, tx } = setup();
    expect(() =>
      service.create('employee', {
        ...dto,
        ...patch,
      } as CreateVoucherCampaignDto),
    ).toThrow(BadRequestException);
    expect(tx.voucherCampaign.create).not.toHaveBeenCalled();
  });

  it('rejects inactive route actors before writing', async () => {
    const { service, tx, dto } = setup();
    tx.employee.findFirst.mockResolvedValue(null);
    await expect(service.create('employee', dto)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    expect(tx.voucherCampaign.create).not.toHaveBeenCalled();
  });

  it('publishes once and preserves publishedAt while resuming a paused campaign', async () => {
    const { service, tx, campaign } = setup();
    await service.publish(campaignId, 'employee', { expectedUpdatedAt: time });
    expect(tx.voucherCampaign.updateMany).toHaveBeenLastCalledWith({
      where: { id: campaignId, updatedAt: time },
      data: { status: 'ACTIVE', publishedAt: expect.any(Date) },
    });
    campaign.status = 'PAUSED';
    campaign.publishedAt = time;
    await service.publish(campaignId, 'employee', { expectedUpdatedAt: time });
    expect(tx.voucherCampaign.updateMany).toHaveBeenLastCalledWith({
      where: { id: campaignId, updatedAt: time },
      data: { status: 'ACTIVE', publishedAt: time },
    });
  });

  it('cannot pause an unpublished draft or publish an expired campaign', async () => {
    const { service, campaign } = setup();
    await expect(
      service.pause(campaignId, 'employee', { expectedUpdatedAt: time }),
    ).rejects.toBeInstanceOf(ConflictException);
    campaign.endDate = new Date('2021-01-01T00:00:00Z');
    await expect(
      service.publish(campaignId, 'employee', { expectedUpdatedAt: time }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('pauses issuance and writes an actor audit without editing financial terms', async () => {
    const { service, tx, campaign } = setup();
    campaign.publishedAt = time;
    campaign.status = 'ACTIVE';
    await service.pause(campaignId, 'employee', { expectedUpdatedAt: time });
    expect(tx.voucherCampaign.updateMany).toHaveBeenCalledWith({
      where: { id: campaignId, updatedAt: time },
      data: { status: 'PAUSED', publishedAt: time },
    });
    expect(tx.actionLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        employeeId: 'employee',
        actionType: 'VOUCHER_CAMPAIGN_PAUSED',
      }),
    });
  });

  it('rejects stale campaign mutations', async () => {
    const { service, tx } = setup();
    await expect(
      service.update(campaignId, 'employee', {
        name: 'New',
        expectedUpdatedAt: new Date(0),
      }),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(tx.voucherCampaign.updateMany).not.toHaveBeenCalled();
  });

  it.each([
    { isPublic: false },
    { discountValue: '11' },
    { minSubtotal: '101' },
    { maxDiscount: '101' },
    { issuanceLimit: 11 },
    { startDate: new Date('2020-01-01T00:00:00.001Z') },
    { endDate: new Date('2099-01-01T00:00:00.001Z') },
  ])(
    'keeps published terms immutable, including millisecond dates: %j',
    async (patch) => {
      const { service, campaign, tx } = setup();
      campaign.status = 'PAUSED';
      campaign.publishedAt = time;
      await expect(
        service.update(campaignId, 'employee', {
          ...patch,
          expectedUpdatedAt: time,
        }),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(tx.voucherCampaign.updateMany).not.toHaveBeenCalled();
    },
  );

  it('allows display changes on a published campaign and audits both values', async () => {
    const { service, campaign, tx } = setup();
    campaign.publishedAt = time;
    campaign.status = 'ACTIVE';
    await service.update(campaignId, 'employee', {
      name: 'New name',
      expectedUpdatedAt: time,
    });
    expect(tx.actionLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        employeeId: 'employee',
        actionType: 'VOUCHER_CAMPAIGN_UPDATED',
        details: expect.objectContaining({
          before: expect.any(Object),
          after: expect.any(Object),
        }),
      }),
    });
  });

  it('lists only public, published, active, in-window and non-exhausted campaigns', async () => {
    const { service, tx } = setup();
    const result = await service.getPublicCampaigns(
      GetPublicVoucherCampaignsDto.schema.parse({
        page: '2',
        itemPerPage: '10',
      }),
    );
    expect(tx.voucherCampaign.findMany).toHaveBeenCalledWith({
      where: {
        isPublic: true,
        status: 'ACTIVE',
        publishedAt: { not: null },
        startDate: { lte: expect.any(Date) },
        endDate: { gt: expect.any(Date) },
        issuedCount: { lt: tx.voucherCampaign.fields.issuanceLimit },
      },
      skip: 10,
      take: 10,
      orderBy: [{ endDate: 'asc' }, { id: 'asc' }],
    });
    expect(result).toMatchObject({
      currentPage: 2,
      totalItems: 1,
      totalPages: 1,
    });
    expect(result.list[0]).not.toHaveProperty('issuedCount');
  });
});
