import { BadRequestException, ConflictException } from '@nestjs/common';
import { DiscountType } from '@prisma/client';
import { Decimal } from '@prisma/client/runtime/library';
import { PromotionPolicyService } from './promotion-policy.service';

describe('PromotionPolicyService', () => {
  let service: PromotionPolicyService;

  beforeEach(() => {
    service = new PromotionPolicyService();
  });

  it('validates strict date ranges', () => {
    expect(() =>
      service.assertDateRangeValid(
        new Date('2026-01-01T00:00:00.000Z'),
        new Date('2026-01-01T00:00:00.000Z'),
      ),
    ).toThrow(BadRequestException);
  });

  it('rejects invalid percentage discounts', () => {
    expect(() =>
      service.assertDiscountValueValid({
        discountType: DiscountType.PERCENTAGE,
        discountValue: new Decimal(101),
        maxDiscount: null,
      }),
    ).toThrow(BadRequestException);
  });

  it('rejects invalid maxDiscount', () => {
    expect(() =>
      service.assertDiscountValueValid({
        discountType: DiscountType.FIXED_AMOUNT,
        discountValue: new Decimal(1000),
        maxDiscount: new Decimal(0),
      }),
    ).toThrow(BadRequestException);
  });

  it('uses [startDate, endDate) for application boundary', () => {
    const promotion = {
      deletedAt: null,
      startDate: new Date('2026-01-01T00:00:00.000Z'),
      endDate: new Date('2026-02-01T00:00:00.000Z'),
    };

    expect(() =>
      service.assertPromotionCanBeApplied(
        promotion,
        new Date('2026-02-01T00:00:00.000Z'),
      ),
    ).toThrow(BadRequestException);
  });

  it('blocks financial field changes after invoice usage', () => {
    expect(() =>
      service.assertFinancialFieldsNotChangedWhenUsed({
        usedInvoiceCount: 1,
        before: {
          discountType: DiscountType.PERCENTAGE,
          discountValue: new Decimal(10),
          maxDiscount: null,
        },
        after: {
          discountType: DiscountType.PERCENTAGE,
          discountValue: new Decimal(15),
          maxDiscount: null,
        },
      }),
    ).toThrow(ConflictException);
  });
});
