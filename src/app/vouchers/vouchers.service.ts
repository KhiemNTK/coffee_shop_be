import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { Decimal } from '@prisma/client/runtime/library';
import {
  PRISMA_SERVICE_TOKEN,
  type ExtendedPrismaClient,
} from '../../common/prisma/prisma.service';
import { runSerializableTransaction } from '../../common/prisma/transaction.util';
import type {
  ExtendedPrismaTransactionClient,
  VoucherDiscountSnapshot,
} from '../../common/types';
import { PaginationUtilService } from '../../common/utils/pagination-util/pagination-util.service';
import { MoneyInputSchema } from '../../common/validation/money.schema';
import { readVoucherSnapshot } from '../../common/validation/voucher-snapshot.schema';
import { IdempotencyService } from '../durable/idempotency.service';
import { PromotionCalculatorService } from '../promotions/services/promotion-calculator.service';
import {
  GetCustomerVouchersDto,
  GetVoucherGrantsDto,
  GiftCustomerVoucherDto,
  RevokeCustomerVoucherDto,
} from './dto/voucher.dto';
import type { VoucherQuoteInput } from './voucher.types';
import {
  adminGrantView,
  grantInclude,
  grantStatusWhere,
  grantView,
  type GrantWithCampaign,
} from './voucher.views';

@Injectable()
export class VouchersService {
  constructor(
    @Inject(PRISMA_SERVICE_TOKEN) private readonly prisma: ExtendedPrismaClient,
    private readonly calculator: PromotionCalculatorService,
    private readonly pagination: PaginationUtilService,
    private readonly idempotency: IdempotencyService,
  ) {}

  async claim(customerId: string, campaignId: string) {
    const grant = await runSerializableTransaction(
      this.prisma,
      async (tx) => {
        const sourceKey = `CLAIM:${customerId}`;
        const replay = await tx.customerVoucher.findUnique({
          where: { campaignId_sourceKey: { campaignId, sourceKey } },
          include: grantInclude,
        });
        if (replay) return grantView(replay, new Date());
        return this.issue(tx, {
          campaignId,
          customerId,
          source: 'CLAIM',
          sourceKey,
        });
      },
      { retryUniqueViolations: true, loggerContext: 'Voucher claim' },
    );
    return { customerId, voucherId: grant.id };
  }

  async gift(
    campaignId: string,
    employeeId: string,
    dto: GiftCustomerVoucherDto,
  ) {
    const sourceKey = `GIFT:${dto.sourceOrderId}`;
    try {
      return await this.idempotency.execute(
        {
          employeeId,
          operation: 'voucher.gift',
          key: dto.idempotencyKey,
          request: {
            campaignId,
            sourceOrderId: dto.sourceOrderId,
            reason: dto.reason,
          },
        },
        async (tx) => {
          await this.assertEmployee(tx, employeeId);
          const order = await tx.onlineOrderRequest.findUnique({
            where: { id: dto.sourceOrderId },
            select: { customerId: true },
          });
          if (!order?.customerId)
            throw new BadRequestException(
              'An authenticated customer order is required.',
            );
          const replay = await tx.customerVoucher.findUnique({
            where: { campaignId_sourceKey: { campaignId, sourceKey } },
            include: grantInclude,
          });
          if (replay)
            return { customerId: replay.customerId, voucherId: replay.id };
          const grant = await this.issue(tx, {
            campaignId,
            customerId: order.customerId,
            source: 'GIFT',
            sourceKey,
            sourceOrderId: dto.sourceOrderId,
            issuedById: employeeId,
            reason: dto.reason,
          });
          await tx.actionLog.create({
            data: {
              employeeId,
              actionType: 'CUSTOMER_VOUCHER_GIFTED',
              details: {
                voucherId: grant.id,
                campaignId,
                sourceOrderId: dto.sourceOrderId,
                customerId: order.customerId,
                reason: dto.reason,
              },
            },
          });
          return { customerId: order.customerId, voucherId: grant.id };
        },
      );
    } catch (error) {
      if (!this.sourceCollision(error)) throw error;
      const replay = await this.prisma.customerVoucher.findUnique({
        where: { campaignId_sourceKey: { campaignId, sourceKey } },
        include: grantInclude,
      });
      if (!replay) throw error;
      return { customerId: replay.customerId, voucherId: replay.id };
    }
  }

  revoke(id: string, employeeId: string, dto: RevokeCustomerVoucherDto) {
    return this.idempotency.execute(
      {
        employeeId,
        operation: 'voucher.revoke',
        key: dto.idempotencyKey,
        request: {
          voucherId: id,
          reason: dto.reason,
          expectedUpdatedAt: dto.expectedUpdatedAt.toISOString(),
        },
      },
      async (tx) => {
        await this.assertEmployee(tx, employeeId);
        await this.lockGrant(tx, id);
        const grant = await tx.customerVoucher.findUnique({
          where: { id },
          include: grantInclude,
        });
        if (!grant) throw new NotFoundException('Voucher not found.');
        if (grant.revokedAt) return grantView(grant, new Date());
        if (grant.updatedAt.getTime() !== dto.expectedUpdatedAt.getTime())
          throw new ConflictException({
            code: 'VOUCHER_CHANGED',
            message: 'Voucher changed. Reload and review.',
          });
        if (grant.redemptions.length)
          throw new ConflictException(
            'A reserved or redeemed voucher cannot be revoked.',
          );
        const changed = await tx.customerVoucher.updateMany({
          where: { id, revokedAt: null, updatedAt: dto.expectedUpdatedAt },
          data: {
            revokedAt: new Date(),
            revokedById: employeeId,
            revocationReason: dto.reason,
          },
        });
        if (changed.count !== 1)
          throw new ConflictException('Voucher changed. Reload and review.');
        await tx.actionLog.create({
          data: {
            employeeId,
            actionType: 'CUSTOMER_VOUCHER_REVOKED',
            details: {
              voucherId: id,
              campaignId: grant.campaignId,
              reason: dto.reason,
            },
          },
        });
        return grantView(
          await tx.customerVoucher.findUniqueOrThrow({
            where: { id },
            include: grantInclude,
          }),
          new Date(),
        );
      },
    );
  }

  getWallet(customerId: string, query: GetCustomerVouchersDto) {
    return runSerializableTransaction(this.prisma, async (tx) => {
      await this.cleanupExpiredInTransaction(tx, {
        customerVoucher: { customerId },
      });
      const now = new Date();
      const where: Prisma.CustomerVoucherWhereInput = {
        AND: [
          { customerId },
          grantStatusWhere(query.status, now),
          ...(query.orderId
            ? [
                {
                  redemptions: {
                    some: { onlineOrderRequestId: query.orderId },
                  },
                },
              ]
            : []),
        ],
      };
      return {
        ...(await this.listGrants(tx, where, query, now, grantView)),
        customerId,
      };
    });
  }

  async getGrant(id: string) {
    const grant = await this.prisma.customerVoucher.findUnique({
      where: { id },
      include: grantInclude,
    });
    if (!grant) throw new NotFoundException('Voucher not found.');
    return adminGrantView(grant, new Date());
  }

  getGrants(campaignId: string, query: GetVoucherGrantsDto) {
    return runSerializableTransaction(this.prisma, async (tx) => {
      const campaign = await tx.voucherCampaign.findUnique({
        where: { id: campaignId },
        select: { id: true },
      });
      if (!campaign) throw new NotFoundException('Voucher campaign not found.');
      const now = new Date();
      const where: Prisma.CustomerVoucherWhereInput = {
        AND: [
          {
            campaignId,
            source: query.source,
            sourceOrderId: query.sourceOrderId,
          },
          grantStatusWhere(query.status, now),
        ],
      };
      return this.listGrants(tx, where, query, now, adminGrantView);
    });
  }

  async quoteInTransaction(
    tx: ExtendedPrismaTransactionClient,
    input: VoucherQuoteInput,
  ): Promise<VoucherDiscountSnapshot> {
    await this.cleanupExpiredInTransaction(tx, {
      customerVoucherId: input.voucherId,
      customerVoucher: { customerId: input.customerId },
    });
    const grant = await this.ownedGrant(tx, input.customerId, input.voucherId);
    return this.calculateSnapshot(
      grant,
      this.subTotal(input.subTotal),
      new Date(),
    );
  }

  async reserveInTransaction(
    tx: ExtendedPrismaTransactionClient,
    input: VoucherQuoteInput & { onlineOrderRequestId: string },
  ): Promise<VoucherDiscountSnapshot> {
    const subTotal = this.subTotal(input.subTotal);
    await this.cleanupExpiredInTransaction(tx, {
      customerVoucherId: input.voucherId,
      customerVoucher: { customerId: input.customerId },
    });
    await this.lockRequest(tx, input.onlineOrderRequestId);
    const request = await tx.onlineOrderRequest.findFirst({
      where: { id: input.onlineOrderRequestId, customerId: input.customerId },
      select: {
        status: true,
        expiresAt: true,
        quotedSubtotal: true,
        quotedTotal: true,
        discountAmount: true,
      },
    });
    if (!request) throw new NotFoundException('Order request not found.');
    const replay = await tx.voucherRedemption.findUnique({
      where: { onlineOrderRequestId: input.onlineOrderRequestId },
      include: { customerVoucher: { select: { customerId: true } } },
    });
    if (replay) {
      if (
        replay.customerVoucherId !== input.voucherId ||
        replay.customerVoucher.customerId !== input.customerId ||
        !replay.subTotal.eq(subTotal) ||
        replay.status === 'RELEASED'
      )
        throw new ConflictException(
          'Voucher reservation does not match this request.',
        );
      const snapshot = readVoucherSnapshot(replay.discountSnapshot);
      if (!snapshot)
        throw new ConflictException(
          'Voucher reservation snapshot is unavailable.',
        );
      return snapshot;
    }
    const now = new Date();
    if (request.status !== 'PENDING' || request.expiresAt <= now)
      throw new ConflictException('Order request is no longer pending.');
    if (!request.quotedSubtotal.eq(subTotal))
      throw new ConflictException(
        'Order subtotal changed. Quote the order again.',
      );
    const grant = await this.ownedGrant(tx, input.customerId, input.voucherId);
    const snapshot = this.calculateSnapshot(grant, subTotal, now);
    if (!request.discountAmount.eq(0) || !request.quotedTotal.eq(subTotal))
      throw new ConflictException(
        'A new voucher reservation requires an undiscounted order.',
      );
    const repriced = await tx.onlineOrderRequest.updateMany({
      where: {
        id: input.onlineOrderRequestId,
        customerId: input.customerId,
        status: 'PENDING',
        expiresAt: { gt: now },
        quotedSubtotal: subTotal,
        discountAmount: 0,
        quotedTotal: subTotal,
      },
      data: {
        discountAmount: snapshot.discountAmount,
        quotedTotal: snapshot.totalAmount,
      },
    });
    if (repriced.count !== 1)
      throw new ConflictException(
        'Order request changed during voucher reservation.',
      );
    await tx.voucherRedemption.create({
      data: {
        customerVoucherId: input.voucherId,
        onlineOrderRequestId: input.onlineOrderRequestId,
        status: 'RESERVED',
        subTotal,
        discountAmount: snapshot.discountAmount,
        totalAmount: snapshot.totalAmount,
        discountSnapshot: { ...snapshot },
      },
    });
    return snapshot;
  }

  async redeemInTransaction(
    tx: ExtendedPrismaTransactionClient,
    requestId: string,
    invoiceId: string,
  ) {
    await this.lockRequest(tx, requestId);
    const redemption = await tx.voucherRedemption.findUnique({
      where: { onlineOrderRequestId: requestId },
      include: { customerVoucher: { select: { customerId: true } } },
    });
    if (!redemption)
      throw new NotFoundException('Voucher reservation not found.');
    if (redemption.status === 'REDEEMED') {
      if (redemption.invoiceId !== invoiceId)
        throw new ConflictException('Voucher was redeemed on another invoice.');
      return {
        voucherId: redemption.customerVoucherId,
        onlineOrderRequestId: requestId,
        invoiceId,
        status: 'REDEEMED' as const,
      };
    }
    if (redemption.status !== 'RESERVED')
      throw new ConflictException('Voucher is not reserved.');
    const request = await tx.onlineOrderRequest.findUnique({
      where: { id: requestId },
      select: { status: true, customerId: true, orderSessionId: true },
    });
    const invoice = await tx.invoice.findUnique({
      where: { id: invoiceId },
      select: {
        orderSessionId: true,
        subTotal: true,
        discountAmount: true,
        totalAmount: true,
        taxAmount: true,
        promotionId: true,
        paymentStatus: true,
      },
    });
    if (invoice && invoice.paymentStatus !== 'PAID')
      throw new ConflictException({
        code: 'VOUCHER_INVOICE_NOT_PAID',
        message: 'Invoice must be paid before voucher redemption.',
      });
    if (
      !request ||
      request.status !== 'ACCEPTED' ||
      request.customerId !== redemption.customerVoucher.customerId ||
      !request.orderSessionId ||
      !invoice ||
      invoice.orderSessionId !== request.orderSessionId ||
      invoice.promotionId !== null ||
      !invoice.subTotal.eq(redemption.subTotal) ||
      !invoice.discountAmount.eq(redemption.discountAmount) ||
      !invoice.totalAmount.eq(redemption.totalAmount) ||
      !invoice.taxAmount.eq(0) ||
      invoice.totalAmount.lte(0)
    )
      throw new ConflictException(
        'Invoice does not match the reserved voucher total.',
      );
    const updated = await tx.voucherRedemption.updateMany({
      where: { id: redemption.id, status: 'RESERVED', invoiceId: null },
      data: { status: 'REDEEMED', invoiceId, redeemedAt: new Date() },
    });
    if (updated.count !== 1)
      throw new ConflictException('Voucher reservation changed.');
    return {
      voucherId: redemption.customerVoucherId,
      onlineOrderRequestId: requestId,
      invoiceId,
      status: 'REDEEMED' as const,
    };
  }

  async releaseInTransaction(
    tx: ExtendedPrismaTransactionClient,
    requestId: string,
    reason: string,
  ) {
    if (!reason.trim() || reason.length > 100)
      throw new BadRequestException('Invalid voucher release reason.');
    await this.lockRequest(tx, requestId);
    const request = await tx.onlineOrderRequest.findUnique({
      where: { id: requestId },
      select: { status: true },
    });
    if (request?.status === 'ACCEPTED')
      throw new ConflictException(
        'An accepted order keeps its voucher reservation.',
      );
    const result = await tx.voucherRedemption.updateMany({
      where: { onlineOrderRequestId: requestId, status: 'RESERVED' },
      data: {
        status: 'RELEASED',
        releasedAt: new Date(),
        releaseReason: reason,
      },
    });
    return { released: result.count === 1 };
  }

  releaseExpiredReservations() {
    return runSerializableTransaction(
      this.prisma,
      (tx) => this.cleanupExpiredInTransaction(tx),
      { loggerContext: 'Voucher expiry cleanup' },
    );
  }

  private async issue(
    tx: ExtendedPrismaTransactionClient,
    data: {
      campaignId: string;
      customerId: string;
      source: 'CLAIM' | 'GIFT';
      sourceKey: string;
      sourceOrderId?: string;
      issuedById?: string;
      reason?: string;
    },
  ) {
    const now = new Date();
    const campaign = await tx.voucherCampaign.findUnique({
      where: { id: data.campaignId },
    });
    if (!campaign || (data.source === 'CLAIM' && !campaign.isPublic))
      throw new NotFoundException('Voucher campaign not found.');
    const customer = await tx.customer.findFirst({
      where: { id: data.customerId, isActive: true, deletedAt: null },
      select: { id: true },
    });
    if (!customer)
      throw new BadRequestException(
        'Customer is not available for voucher issuance.',
      );
    const issued = await tx.voucherCampaign.updateMany({
      where: {
        id: campaign.id,
        status: 'ACTIVE',
        publishedAt: { not: null },
        startDate: { lte: now },
        endDate: { gt: now },
        issuedCount: { lt: campaign.issuanceLimit },
        ...(data.source === 'CLAIM' ? { isPublic: true } : {}),
      },
      // Quota changes must not invalidate the observed configuration version.
      data: { issuedCount: { increment: 1 }, updatedAt: campaign.updatedAt },
    });
    if (issued.count !== 1)
      throw new ConflictException({
        code: 'VOUCHER_ISSUANCE_UNAVAILABLE',
        message: 'Voucher campaign is not available for issuance.',
      });
    const grant = await tx.customerVoucher.create({
      data,
      include: grantInclude,
    });
    return grantView(grant, now);
  }

  private async listGrants<T>(
    tx: ExtendedPrismaTransactionClient,
    where: Prisma.CustomerVoucherWhereInput,
    query: { page: number; itemPerPage: number },
    now: Date,
    view: (grant: GrantWithCampaign, now: Date) => T,
  ) {
    const totalItems = await tx.customerVoucher.count({ where });
    const paging = this.pagination.paging({ ...query, totalItems });
    const grants = await tx.customerVoucher.findMany({
      where,
      include: grantInclude,
      skip: paging.skip,
      take: paging.itemPerPage,
      orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
    });
    return paging.format(grants.map((grant) => view(grant, now)));
  }

  private async ownedGrant(
    tx: ExtendedPrismaTransactionClient,
    customerId: string,
    id: string,
  ) {
    await tx.$queryRaw`SELECT "id" FROM "CustomerVoucher" WHERE "id" = ${id} AND "customerId" = ${customerId} FOR UPDATE`;
    const grant = await tx.customerVoucher.findFirst({
      where: { id, customerId },
      include: grantInclude,
    });
    if (!grant) throw new NotFoundException('Voucher not found.');
    return grant;
  }

  private calculateSnapshot(
    grant: GrantWithCampaign,
    subTotal: Decimal,
    now: Date,
  ): VoucherDiscountSnapshot {
    const campaign = grant.campaign;
    if (grant.revokedAt)
      throw new ConflictException({
        code: 'VOUCHER_REVOKED',
        message: 'Voucher has been revoked.',
      });
    if (grant.redemptions.some((row) => row.status === 'REDEEMED'))
      throw new ConflictException({
        code: 'VOUCHER_USED',
        message: 'Voucher has already been used.',
      });
    if (grant.redemptions.some((row) => row.status === 'RESERVED'))
      throw new ConflictException({
        code: 'VOUCHER_RESERVED',
        message: 'Voucher is reserved for another order.',
      });
    if (campaign.endDate <= now)
      throw new ConflictException({
        code: 'VOUCHER_EXPIRED',
        message: 'Voucher has expired.',
      });
    if (
      !campaign.publishedAt ||
      campaign.status === 'DRAFT' ||
      campaign.startDate > now
    )
      throw new ConflictException({
        code: 'VOUCHER_NOT_ACTIVE',
        message: 'Voucher is not active yet.',
      });
    if (subTotal.lt(campaign.minSubtotal))
      throw new ConflictException({
        code: 'VOUCHER_MIN_SUBTOTAL',
        message: 'Order subtotal does not meet the voucher minimum.',
      });
    const discountAmount = this.calculator.calculateDiscountAmount({
      subTotal,
      discountType: campaign.discountType,
      discountValue: campaign.discountValue,
      maxDiscount: campaign.maxDiscount,
    });
    const totalAmount = subTotal.minus(discountAmount);
    if (totalAmount.lte(0))
      throw new BadRequestException({
        code: 'VOUCHER_ZERO_TOTAL',
        message: 'Voucher must leave a positive order total.',
      });
    if (discountAmount.lte(0))
      throw new BadRequestException({
        code: 'VOUCHER_NOT_ACTIVE',
        message: 'Voucher does not provide a discount for this order.',
      });
    return {
      voucherId: grant.id,
      campaignId: campaign.id,
      name: campaign.name,
      discountType: campaign.discountType,
      discountValue: campaign.discountValue.toFixed(2),
      maxDiscount: campaign.maxDiscount?.toFixed(2) ?? null,
      minSubtotal: campaign.minSubtotal.toFixed(2),
      startDate: campaign.startDate.toISOString(),
      endDate: campaign.endDate.toISOString(),
      discountAmount: discountAmount.toFixed(2),
      totalAmount: totalAmount.toFixed(2),
    };
  }

  private subTotal(value: string | Decimal) {
    const parsed = MoneyInputSchema.safeParse(
      Decimal.isDecimal(value) ? value.toString() : value,
    );
    if (!parsed.success || new Decimal(parsed.data).lte(0))
      throw new BadRequestException('Invalid order subtotal.');
    return new Decimal(parsed.data);
  }

  private async cleanupExpiredInTransaction(
    tx: ExtendedPrismaTransactionClient,
    scope: Prisma.VoucherRedemptionWhereInput = {},
  ) {
    const now = new Date();
    const expired = await tx.voucherRedemption.findMany({
      where: {
        ...scope,
        status: 'RESERVED',
        onlineOrderRequest: { status: 'PENDING', expiresAt: { lte: now } },
      },
      select: { onlineOrderRequestId: true },
      orderBy: { onlineOrderRequestId: 'asc' },
      take: 100,
    });
    let released = 0;
    for (const row of expired) {
      // Lock the request before rechecking so acceptance and expiry cannot both win.
      await this.lockRequest(tx, row.onlineOrderRequestId);
      const result = await tx.voucherRedemption.updateMany({
        where: {
          onlineOrderRequestId: row.onlineOrderRequestId,
          status: 'RESERVED',
          onlineOrderRequest: { status: 'PENDING', expiresAt: { lte: now } },
        },
        data: {
          status: 'RELEASED',
          releasedAt: now,
          releaseReason: 'REQUEST_EXPIRED',
        },
      });
      released += result.count;
    }
    return { released };
  }

  private async lockRequest(tx: ExtendedPrismaTransactionClient, id: string) {
    await tx.$queryRaw`SELECT "id" FROM "OnlineOrderRequest" WHERE "id" = ${id} FOR UPDATE`;
  }

  private async lockGrant(tx: ExtendedPrismaTransactionClient, id: string) {
    await tx.$queryRaw`SELECT "id" FROM "CustomerVoucher" WHERE "id" = ${id} FOR UPDATE`;
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

  private sourceCollision(error: unknown) {
    if (
      !(error instanceof Prisma.PrismaClientKnownRequestError) ||
      error.code !== 'P2002'
    )
      return false;
    const target = error.meta?.target;
    return (
      (Array.isArray(target) &&
        target.includes('campaignId') &&
        target.includes('sourceKey')) ||
      target === 'CustomerVoucher_campaignId_sourceKey_key'
    );
  }
}
