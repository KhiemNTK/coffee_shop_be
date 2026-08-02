import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { DiscountType } from '@prisma/client';
import { Decimal } from '@prisma/client/runtime/library';
import type {
  ExtendedPrismaTransactionClient,
  PromotionCalculationInput,
  PromotionCalculationResult,
} from '../../../common/types';
import { PromotionPolicyService } from '../policies/promotion-policy.service';
import { PromotionsRepository } from '../repositories/promotions.repository';

@Injectable()
export class PromotionCalculatorService {
  constructor(
    private readonly promotionsRepository: PromotionsRepository,
    private readonly promotionPolicy: PromotionPolicyService,
  ) {}

  async calculateDiscount(
    input: PromotionCalculationInput,
  ): Promise<PromotionCalculationResult> {
    return this.calculateDiscountTx(this.promotionsRepository.client, input);
  }

  async calculateDiscountTx(
    tx: ExtendedPrismaTransactionClient,
    { promotionId, subTotal, at = new Date() }: PromotionCalculationInput,
  ): Promise<PromotionCalculationResult> {
    const resolvedSubTotal = this.promotionPolicy.toNonNegativeDecimal(
      subTotal,
      'subTotal',
    );
    const promotion = await this.promotionsRepository.findByIdIncludingDeleted(
      promotionId,
      tx,
    );

    if (!promotion) {
      throw new NotFoundException(
        `Promotion with ID ${promotionId} not found.`,
      );
    }

    this.promotionPolicy.assertPromotionCanBeApplied(promotion, at);

    const discountAmount = this.calculateDiscountAmount({
      subTotal: resolvedSubTotal,
      discountType: promotion.discountType,
      discountValue: promotion.discountValue,
      maxDiscount: promotion.maxDiscount,
    });

    return {
      promotionId: promotion.id,
      promotionName: promotion.name,
      discountType: promotion.discountType,
      discountValue: promotion.discountValue,
      maxDiscount: promotion.maxDiscount,
      discountAmount,
    };
  }

  calculateDiscountAmount({
    subTotal,
    discountType,
    discountValue,
    maxDiscount,
  }: {
    subTotal: Decimal;
    discountType: DiscountType;
    discountValue: Decimal;
    maxDiscount: Decimal | null;
  }) {
    if (subTotal.lt(0)) {
      throw new BadRequestException('Sub total cannot be negative.');
    }

    const rawDiscount =
      discountType === DiscountType.PERCENTAGE
        ? subTotal.mul(discountValue).div(100)
        : discountValue;
    const cappedByPromotion = maxDiscount
      ? Decimal.min(rawDiscount, maxDiscount)
      : rawDiscount;
    const discountAmount = Decimal.min(
      cappedByPromotion,
      subTotal,
    ).toDecimalPlaces(2);

    if (discountAmount.lt(0)) {
      throw new BadRequestException('Discount amount cannot be negative.');
    }

    if (discountAmount.gt(subTotal)) {
      throw new BadRequestException('Discount amount cannot exceed sub total.');
    }

    return discountAmount;
  }
}
