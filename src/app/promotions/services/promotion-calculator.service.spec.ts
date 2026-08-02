import { BadRequestException } from '@nestjs/common';
import { DiscountType } from '@prisma/client';
import { Decimal } from '@prisma/client/runtime/library';
import { PromotionPolicyService } from '../policies/promotion-policy.service';
import { PromotionsRepository } from '../repositories/promotions.repository';
import { PromotionCalculatorService } from './promotion-calculator.service';

describe('PromotionCalculatorService', () => {
  let service: PromotionCalculatorService;

  beforeEach(() => {
    service = new PromotionCalculatorService(
      {
        client: {},
      } as PromotionsRepository,
      new PromotionPolicyService(),
    );
  });

  it('calculates percentage discount', () => {
    const discount = service.calculateDiscountAmount({
      subTotal: new Decimal(200000),
      discountType: DiscountType.PERCENTAGE,
      discountValue: new Decimal(10),
      maxDiscount: null,
    });

    expect(discount.eq(20000)).toBe(true);
  });

  it('clamps discount by maxDiscount', () => {
    const discount = service.calculateDiscountAmount({
      subTotal: new Decimal(200000),
      discountType: DiscountType.PERCENTAGE,
      discountValue: new Decimal(50),
      maxDiscount: new Decimal(30000),
    });

    expect(discount.eq(30000)).toBe(true);
  });

  it('does not discount more than subTotal', () => {
    const discount = service.calculateDiscountAmount({
      subTotal: new Decimal(50000),
      discountType: DiscountType.FIXED_AMOUNT,
      discountValue: new Decimal(100000),
      maxDiscount: null,
    });

    expect(discount.eq(50000)).toBe(true);
  });

  it('rejects negative subtotals', () => {
    expect(() =>
      service.calculateDiscountAmount({
        subTotal: new Decimal(-1),
        discountType: DiscountType.FIXED_AMOUNT,
        discountValue: new Decimal(1000),
        maxDiscount: null,
      }),
    ).toThrow(BadRequestException);
  });
});
