import {
  BadRequestException,
  ConflictException,
  Injectable,
} from '@nestjs/common';
import { DiscountType } from '@prisma/client';
import { Decimal } from '@prisma/client/runtime/library';

@Injectable()
export class PromotionPolicyService {
  toPositiveDecimal(value: string | number | Decimal, fieldName: string) {
    const decimal = new Decimal(value).toDecimalPlaces(4);
    if (!decimal.isFinite() || decimal.lte(0)) {
      throw new BadRequestException(`${fieldName} must be greater than 0.`);
    }
    return decimal;
  }

  toNonNegativeDecimal(value: string | number | Decimal, fieldName: string) {
    const decimal = new Decimal(value).toDecimalPlaces(4);
    if (!decimal.isFinite() || decimal.lt(0)) {
      throw new BadRequestException(
        `${fieldName} must be greater than or equal to 0.`,
      );
    }
    return decimal;
  }

  assertActiveEmployee(employee: { isActive: boolean } | null) {
    if (!employee?.isActive) {
      throw new BadRequestException('Employee is inactive or not found.');
    }
  }

  assertDateRangeValid(startDate: Date, endDate: Date) {
    if (startDate >= endDate) {
      throw new BadRequestException('Start date must be before end date.');
    }
  }

  assertDiscountValueValid({
    discountType,
    discountValue,
    maxDiscount,
  }: {
    discountType: DiscountType;
    discountValue: Decimal;
    maxDiscount: Decimal | null;
  }) {
    if (discountType === DiscountType.PERCENTAGE && discountValue.gt(100)) {
      throw new BadRequestException(
        'Percentage discount must be between 0 and 100.',
      );
    }

    if (discountValue.lte(0)) {
      throw new BadRequestException('Discount value must be greater than 0.');
    }

    if (maxDiscount && maxDiscount.lte(0)) {
      throw new BadRequestException('Max discount must be greater than 0.');
    }
  }

  assertPromotionCanBeApplied(
    promotion: {
      deletedAt: Date | null;
      startDate: Date;
      endDate: Date;
    } | null,
    at: Date,
  ) {
    if (!promotion) {
      throw new BadRequestException('Promotion is not available.');
    }

    if (promotion.deletedAt) {
      throw new BadRequestException('Promotion has been deleted.');
    }

    if (at < promotion.startDate) {
      throw new BadRequestException('Promotion is not active yet.');
    }

    if (at >= promotion.endDate) {
      throw new BadRequestException('Promotion is expired.');
    }
  }

  assertPromotionCanBeUpdated(promotion: { deletedAt: Date | null } | null) {
    if (!promotion || promotion.deletedAt) {
      throw new BadRequestException('Promotion is deleted or not found.');
    }
  }

  assertPromotionCanBeDeleted(promotion: { deletedAt: Date | null } | null) {
    if (!promotion) {
      throw new BadRequestException('Promotion is not found.');
    }

    if (promotion.deletedAt) {
      throw new ConflictException('Promotion has already been deleted.');
    }
  }

  assertPromotionCanBeRestored(
    promotion: { deletedAt: Date | null } | null,
  ): asserts promotion is { deletedAt: Date } {
    if (!promotion) {
      throw new BadRequestException('Promotion is not found.');
    }

    if (!promotion.deletedAt) {
      throw new ConflictException('Promotion is not deleted.');
    }
  }

  assertFinancialFieldsNotChangedWhenUsed({
    usedInvoiceCount,
    before,
    after,
  }: {
    usedInvoiceCount: number;
    before: {
      discountType: DiscountType;
      discountValue: Decimal;
      maxDiscount: Decimal | null;
    };
    after: {
      discountType: DiscountType;
      discountValue: Decimal;
      maxDiscount: Decimal | null;
    };
  }) {
    if (usedInvoiceCount === 0) return;

    const financialFieldsChanged =
      before.discountType !== after.discountType ||
      !before.discountValue.eq(after.discountValue) ||
      !this.optionalDecimalEquals(before.maxDiscount, after.maxDiscount);

    if (financialFieldsChanged) {
      throw new ConflictException(
        'Cannot update financial promotion fields because this promotion has been used by invoices.',
      );
    }
  }

  private optionalDecimalEquals(left: Decimal | null, right: Decimal | null) {
    if (!left && !right) return true;
    if (!left || !right) return false;
    return left.eq(right);
  }
}
