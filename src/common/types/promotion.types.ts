import type { DiscountType } from '@prisma/client';
import type { Decimal } from '@prisma/client/runtime/library';

export type PromotionStatus = 'ACTIVE' | 'UPCOMING' | 'EXPIRED' | 'DELETED';

export interface PromotionCalculationInput {
  promotionId: string;
  subTotal: Decimal;
  at?: Date;
}

export interface PromotionCalculationResult {
  promotionId: string;
  promotionName: string;
  discountType: DiscountType;
  discountValue: Decimal;
  maxDiscount: Decimal | null;
  discountAmount: Decimal;
}
