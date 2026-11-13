import { z } from 'zod';
import type { VoucherDiscountSnapshot } from '../types';

const money = z.string().regex(/^(0|[1-9]\d{0,15})(\.\d{1,2})?$/);

export const VoucherDiscountSnapshotSchema = z.object({
  voucherId: z.uuid(),
  campaignId: z.uuid(),
  name: z.string().min(1).max(120),
  discountType: z.enum(['PERCENTAGE', 'FIXED_AMOUNT']),
  discountValue: money,
  maxDiscount: money.nullable(),
  minSubtotal: money,
  startDate: z.iso.datetime(),
  endDate: z.iso.datetime(),
  discountAmount: money,
  totalAmount: money,
});

export function readVoucherSnapshot(
  value: unknown,
): VoucherDiscountSnapshot | null {
  return value == null ? null : VoucherDiscountSnapshotSchema.parse(value);
}
