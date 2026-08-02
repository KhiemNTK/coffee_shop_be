import { Injectable, NotFoundException } from '@nestjs/common';
import { DiscountType, Prisma } from '@prisma/client';
import { Decimal } from '@prisma/client/runtime/library';
import type { PromotionStatus } from '../../../common/types';
import { PaginationUtilService } from '../../../common/utils/pagination-util/pagination-util.service';
import {
  GetActivePromotionsDto,
  SearchPromotionsDto,
} from '../dto/promotion-common.dto';
import { PromotionsRepository } from '../repositories/promotions.repository';
import { PromotionCalculatorService } from './promotion-calculator.service';

@Injectable()
export class PromotionQueryService {
  constructor(
    private readonly promotionsRepository: PromotionsRepository,
    private readonly paginationUtilService: PaginationUtilService,
    private readonly promotionCalculator: PromotionCalculatorService,
  ) {}

  async search({
    page,
    itemPerPage,
    keyword,
    discountType,
    status,
    validAt,
    includeDeleted,
    sortBy,
    sortOrder,
  }: SearchPromotionsDto) {
    const now = validAt ?? new Date();
    const where = this.buildSearchWhere({
      keyword,
      discountType,
      status,
      validAt,
      includeDeleted,
      now,
    });
    const totalItems = await this.promotionsRepository.client.promotion.count({
      where,
    });
    const paging = this.paginationUtilService.paging({
      page,
      itemPerPage,
      totalItems,
    });
    const list = await this.promotionsRepository.client.promotion.findMany({
      where,
      select: this.promotionSelect,
      skip: paging.skip,
      take: paging.itemPerPage,
      orderBy: { [sortBy]: sortOrder },
    });

    return paging.format(
      list.map((promotion) => this.toPromotionResponse(promotion, now)),
    );
  }

  async findActive({ at, subTotal }: GetActivePromotionsDto) {
    const validAt = at ?? new Date();
    const resolvedSubTotal =
      subTotal !== undefined ? new Decimal(subTotal) : null;
    const promotions =
      await this.promotionsRepository.client.promotion.findMany({
        where: {
          deletedAt: null,
          startDate: { lte: validAt },
          endDate: { gt: validAt },
        },
        select: this.promotionSelect,
        orderBy: { createdAt: 'desc' },
      });

    return {
      list: promotions.map((promotion) => {
        const estimatedDiscountAmount = resolvedSubTotal
          ? this.promotionCalculator.calculateDiscountAmount({
              subTotal: resolvedSubTotal,
              discountType: promotion.discountType,
              discountValue: promotion.discountValue,
              maxDiscount: promotion.maxDiscount,
            })
          : undefined;

        return {
          ...this.toPromotionResponse(promotion, validAt),
          ...(estimatedDiscountAmount ? { estimatedDiscountAmount } : {}),
        };
      }),
    };
  }

  async findOne(id: string) {
    const promotion =
      await this.promotionsRepository.client.promotion.findFirst({
        where: {
          id,
          __includeDeleted: true,
        } as Prisma.PromotionWhereInput & { __includeDeleted: true },
        select: this.promotionSelect,
      });

    if (!promotion) {
      throw new NotFoundException(`Promotion with ID ${id} not found.`);
    }

    return this.toPromotionResponse(promotion, new Date());
  }

  private readonly promotionSelect = {
    id: true,
    name: true,
    startDate: true,
    endDate: true,
    discountType: true,
    discountValue: true,
    maxDiscount: true,
    createdAt: true,
    updatedAt: true,
    deletedAt: true,
    _count: {
      select: {
        invoices: true,
      },
    },
  } as const;

  private buildSearchWhere({
    keyword,
    discountType,
    status,
    validAt,
    includeDeleted,
    now,
  }: {
    keyword?: string;
    discountType?: DiscountType;
    status?: PromotionStatus;
    validAt?: Date;
    includeDeleted?: boolean;
    now: Date;
  }) {
    const where: Prisma.PromotionWhereInput & { __includeDeleted?: true } = {
      ...(keyword
        ? {
            name: { contains: keyword, mode: Prisma.QueryMode.insensitive },
          }
        : {}),
      ...(discountType ? { discountType } : {}),
    };

    if (status === 'DELETED') {
      where.deletedAt = { not: null };
      return where;
    }

    if (status === 'ACTIVE' || validAt) {
      const at = validAt ?? now;
      where.deletedAt = null;
      where.startDate = { lte: at };
      where.endDate = { gt: at };
      return where;
    }

    if (status === 'UPCOMING') {
      where.deletedAt = null;
      where.startDate = { gt: now };
      return where;
    }

    if (status === 'EXPIRED') {
      where.deletedAt = null;
      where.endDate = { lte: now };
      return where;
    }

    if (includeDeleted) {
      where.__includeDeleted = true;
      return where;
    }

    where.deletedAt = null;
    return where;
  }

  private toPromotionResponse(
    promotion: {
      id: string;
      name: string;
      startDate: Date;
      endDate: Date;
      discountType: string;
      discountValue: Decimal;
      maxDiscount: Decimal | null;
      createdAt: Date;
      updatedAt: Date;
      deletedAt: Date | null;
      _count: { invoices: number };
    },
    now: Date,
  ) {
    return {
      id: promotion.id,
      name: promotion.name,
      startDate: promotion.startDate,
      endDate: promotion.endDate,
      discountType: promotion.discountType,
      discountValue: promotion.discountValue,
      maxDiscount: promotion.maxDiscount,
      status: this.resolveStatus(promotion, now),
      usageCount: promotion._count.invoices,
      createdAt: promotion.createdAt,
      updatedAt: promotion.updatedAt,
      deletedAt: promotion.deletedAt,
    };
  }

  private resolveStatus(
    promotion: {
      startDate: Date;
      endDate: Date;
      deletedAt: Date | null;
    },
    now: Date,
  ): PromotionStatus {
    if (promotion.deletedAt) return 'DELETED';
    if (now < promotion.startDate) return 'UPCOMING';
    if (now >= promotion.endDate) return 'EXPIRED';
    return 'ACTIVE';
  }
}
