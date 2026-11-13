import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { DiscountType, Prisma, type VoucherCampaign } from '@prisma/client';
import { Decimal } from '@prisma/client/runtime/library';
import {
  PRISMA_SERVICE_TOKEN,
  type ExtendedPrismaClient,
} from '../../common/prisma/prisma.service';
import { runSerializableTransaction } from '../../common/prisma/transaction.util';
import type { ExtendedPrismaTransactionClient } from '../../common/types';
import { PaginationUtilService } from '../../common/utils/pagination-util/pagination-util.service';
import { MoneyInputSchema } from '../../common/validation/money.schema';
import {
  CreateVoucherCampaignDto,
  GetPublicVoucherCampaignsDto,
  GetVoucherCampaignsDto,
  UpdateVoucherCampaignDto,
  VoucherCampaignVersionDto,
} from './dto/voucher.dto';
import { campaignTerms, campaignView } from './voucher.views';

@Injectable()
export class VoucherCampaignsService {
  constructor(
    @Inject(PRISMA_SERVICE_TOKEN) private readonly prisma: ExtendedPrismaClient,
    private readonly pagination: PaginationUtilService,
  ) {}

  create(employeeId: string, dto: CreateVoucherCampaignDto) {
    const terms = this.terms(dto);
    return runSerializableTransaction(this.prisma, async (tx) => {
      await this.assertEmployee(tx, employeeId);
      const campaign = await tx.voucherCampaign.create({
        data: { ...dto, ...terms, status: 'DRAFT', issuedCount: 0 },
      });
      await tx.actionLog.create({
        data: {
          employeeId,
          actionType: 'VOUCHER_CAMPAIGN_CREATED',
          details: {
            campaignId: campaign.id,
            terms: campaignTerms(campaign),
            issuanceLimit: campaign.issuanceLimit,
          },
        },
      });
      return campaignView(campaign);
    });
  }

  findOne(id: string) {
    return runSerializableTransaction(this.prisma, async (tx) => {
      const campaign = await tx.voucherCampaign.findUnique({ where: { id } });
      if (!campaign) throw new NotFoundException('Voucher campaign not found.');
      const claimed = await tx.customerVoucher.count({
        where: { campaignId: id, source: 'CLAIM' },
      });
      const gifted = await tx.customerVoucher.count({
        where: { campaignId: id, source: 'GIFT' },
      });
      const reserved = await tx.voucherRedemption.count({
        where: { customerVoucher: { campaignId: id }, status: 'RESERVED' },
      });
      const redeemed = await tx.voucherRedemption.count({
        where: { customerVoucher: { campaignId: id }, status: 'REDEEMED' },
      });
      const revoked = await tx.customerVoucher.count({
        where: { campaignId: id, revokedAt: { not: null } },
      });
      return {
        ...campaignView(campaign),
        stats: { claimed, gifted, reserved, redeemed, revoked },
      };
    });
  }

  findAll(query: GetVoucherCampaignsDto) {
    const where: Prisma.VoucherCampaignWhereInput = {
      status: query.status,
      ...(query.keyword
        ? { name: { contains: query.keyword, mode: 'insensitive' } }
        : {}),
    };
    return runSerializableTransaction(this.prisma, async (tx) => {
      const totalItems = await tx.voucherCampaign.count({ where });
      const paging = this.pagination.paging({ ...query, totalItems });
      const rows = await tx.voucherCampaign.findMany({
        where,
        skip: paging.skip,
        take: paging.itemPerPage,
        orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
      });
      return paging.format(rows.map(campaignView));
    });
  }

  getPublicCampaigns(query: GetPublicVoucherCampaignsDto) {
    return runSerializableTransaction(this.prisma, async (tx) => {
      const now = new Date();
      const where: Prisma.VoucherCampaignWhereInput = {
        isPublic: true,
        status: 'ACTIVE',
        publishedAt: { not: null },
        startDate: { lte: now },
        endDate: { gt: now },
        issuedCount: { lt: tx.voucherCampaign.fields.issuanceLimit },
      };
      const totalItems = await tx.voucherCampaign.count({ where });
      const paging = this.pagination.paging({ ...query, totalItems });
      const rows = await tx.voucherCampaign.findMany({
        where,
        skip: paging.skip,
        take: paging.itemPerPage,
        orderBy: [{ endDate: 'asc' }, { id: 'asc' }],
      });
      return paging.format(rows.map(campaignTerms));
    });
  }

  update(id: string, employeeId: string, dto: UpdateVoucherCampaignDto) {
    return runSerializableTransaction(this.prisma, async (tx) => {
      await this.assertEmployee(tx, employeeId);
      const campaign = await tx.voucherCampaign.findUnique({ where: { id } });
      if (!campaign) throw new NotFoundException('Voucher campaign not found.');
      this.assertVersion(campaign, dto.expectedUpdatedAt);
      const { expectedUpdatedAt, ...patch } = dto;
      const merged = { ...campaign, ...patch };
      const terms = this.terms(merged);
      if (campaign.publishedAt) {
        const immutable = [
          'isPublic',
          'discountType',
          'discountValue',
          'maxDiscount',
          'minSubtotal',
          'startDate',
          'endDate',
          'issuanceLimit',
        ] as const;
        const before = { ...campaign, ...this.terms(campaign) };
        const after = { ...merged, ...terms };
        const comparable = (value: unknown) =>
          value instanceof Date ? value.toISOString() : String(value);
        if (
          immutable.some(
            (key) => comparable(before[key]) !== comparable(after[key]),
          )
        )
          throw new ConflictException(
            'Published voucher terms cannot be changed.',
          );
      }
      const changed = await tx.voucherCampaign.updateMany({
        where: { id, updatedAt: expectedUpdatedAt },
        data: { ...patch, ...terms },
      });
      if (changed.count !== 1) this.changed();
      const updated = await tx.voucherCampaign.findUniqueOrThrow({
        where: { id },
      });
      await tx.actionLog.create({
        data: {
          employeeId,
          actionType: 'VOUCHER_CAMPAIGN_UPDATED',
          details: {
            campaignId: id,
            before: campaignTerms(campaign),
            after: campaignTerms(updated),
            beforeIssuanceLimit: campaign.issuanceLimit,
            afterIssuanceLimit: updated.issuanceLimit,
          },
        },
      });
      return campaignView(updated);
    });
  }

  publish(id: string, employeeId: string, dto: VoucherCampaignVersionDto) {
    return this.setStatus(id, employeeId, dto, 'ACTIVE');
  }

  pause(id: string, employeeId: string, dto: VoucherCampaignVersionDto) {
    return this.setStatus(id, employeeId, dto, 'PAUSED');
  }

  private setStatus(
    id: string,
    employeeId: string,
    dto: VoucherCampaignVersionDto,
    status: 'ACTIVE' | 'PAUSED',
  ) {
    return runSerializableTransaction(this.prisma, async (tx) => {
      await this.assertEmployee(tx, employeeId);
      const campaign = await tx.voucherCampaign.findUnique({ where: { id } });
      if (!campaign) throw new NotFoundException('Voucher campaign not found.');
      this.assertVersion(campaign, dto.expectedUpdatedAt);
      if (status === 'PAUSED' && !campaign.publishedAt)
        throw new ConflictException('Publish the voucher campaign first.');
      this.terms(campaign);
      const now = new Date();
      if (status === 'ACTIVE' && campaign.endDate <= now)
        throw new BadRequestException(
          'An expired campaign cannot be published.',
        );
      const changed = await tx.voucherCampaign.updateMany({
        where: { id, updatedAt: dto.expectedUpdatedAt },
        data: { status, publishedAt: campaign.publishedAt ?? now },
      });
      if (changed.count !== 1) this.changed();
      await tx.actionLog.create({
        data: {
          employeeId,
          actionType:
            status === 'ACTIVE'
              ? 'VOUCHER_CAMPAIGN_PUBLISHED'
              : 'VOUCHER_CAMPAIGN_PAUSED',
          details: {
            campaignId: id,
            beforeStatus: campaign.status,
            afterStatus: status,
          },
        },
      });
      return campaignView(
        await tx.voucherCampaign.findUniqueOrThrow({ where: { id } }),
      );
    });
  }

  private terms(input: {
    discountType: DiscountType;
    discountValue: string | number | Decimal;
    maxDiscount?: string | number | Decimal | null;
    minSubtotal: string | number | Decimal;
    startDate: Date;
    endDate: Date;
    issuanceLimit: number;
  }) {
    const money = (value: string | number | Decimal, field: string) => {
      const parsed = MoneyInputSchema.safeParse(
        Decimal.isDecimal(value) ? value.toString() : value,
      );
      if (!parsed.success) throw new BadRequestException(`Invalid ${field}.`);
      return new Decimal(parsed.data);
    };
    const discountValue = money(input.discountValue, 'discountValue');
    const minSubtotal = money(input.minSubtotal, 'minSubtotal');
    const maxDiscount =
      input.maxDiscount == null
        ? null
        : money(input.maxDiscount, 'maxDiscount');
    if (discountValue.lte(0) || minSubtotal.lte(0) || maxDiscount?.lte(0))
      throw new BadRequestException('Voucher amounts must be positive.');
    if (
      input.discountType === DiscountType.PERCENTAGE &&
      discountValue.gte(100)
    )
      throw new BadRequestException(
        'Percentage discount must be less than 100.',
      );
    if (input.discountType === DiscountType.PERCENTAGE && maxDiscount === null)
      throw new BadRequestException(
        'Percentage vouchers require a maximum discount.',
      );
    if (
      input.discountType === DiscountType.FIXED_AMOUNT &&
      minSubtotal.lte(discountValue)
    )
      throw new BadRequestException(
        'Minimum subtotal must exceed the fixed discount.',
      );
    if (
      !Number.isFinite(input.startDate.getTime()) ||
      !Number.isFinite(input.endDate.getTime()) ||
      input.startDate >= input.endDate
    )
      throw new BadRequestException('Start date must be before end date.');
    if (
      !Number.isInteger(input.issuanceLimit) ||
      input.issuanceLimit < 1 ||
      input.issuanceLimit > 2_147_483_647
    )
      throw new BadRequestException('Invalid issuance limit.');
    return { discountValue, maxDiscount, minSubtotal };
  }

  private assertVersion(campaign: VoucherCampaign, expected: Date) {
    if (campaign.updatedAt.getTime() !== expected.getTime()) this.changed();
  }

  private async assertEmployee(
    tx: ExtendedPrismaTransactionClient,
    id: string,
  ) {
    const employee = await tx.employee.findFirst({
      where: { id, isActive: true, deletedAt: null },
      select: { id: true },
    });
    if (!employee) throw new UnauthorizedException('Employee is inactive.');
  }

  private changed(): never {
    throw new ConflictException({
      code: 'VOUCHER_CAMPAIGN_CHANGED',
      message: 'Voucher campaign changed. Reload and review.',
    });
  }
}
