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

export type PromotionEventName =
  | 'promotion.created'
  | 'promotion.updated'
  | 'promotion.deleted'
  | 'promotion.restored'
  | 'promotion.applied';

export interface PromotionEventBase {
  eventId: string;
  occurredAt: string;
  promotionId: string;
}

export interface PromotionChangedPayload extends PromotionEventBase {
  name: string;
}

export interface PromotionAppliedPayload extends PromotionEventBase {
  invoiceId?: string;
  discountAmount: Decimal;
}

export interface PromotionEventPayloadMap {
  'promotion.created': PromotionChangedPayload;
  'promotion.updated': PromotionChangedPayload;
  'promotion.deleted': PromotionChangedPayload;
  'promotion.restored': PromotionChangedPayload;
  'promotion.applied': PromotionAppliedPayload;
}

export type PromotionEventListener<TEventName extends PromotionEventName> = (
  payload: PromotionEventPayloadMap[TEventName],
) => void | Promise<void>;
