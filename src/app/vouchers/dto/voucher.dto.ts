import { DiscountType } from '@prisma/client';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { MoneyInputSchema } from '../../../common/validation/money.schema';

const DateSchema = z.iso
  .datetime({ offset: true })
  .transform((value) => new Date(value));
const PageSchema = z.strictObject({
  page: z.coerce.number().int().min(1).max(1_000_000).default(1),
  itemPerPage: z.coerce.number().int().min(1).max(100).default(20),
});
const CampaignSchema = z.strictObject({
  name: z.string().trim().min(1).max(100),
  description: z.string().trim().max(500).nullable().optional(),
  isPublic: z.boolean(),
  discountType: z.enum(DiscountType),
  discountValue: MoneyInputSchema,
  maxDiscount: MoneyInputSchema.nullable().optional(),
  minSubtotal: MoneyInputSchema,
  startDate: DateSchema,
  endDate: DateSchema,
  issuanceLimit: z.number().int().min(1).max(2_147_483_647),
});
export const VoucherWalletStatusSchema = z.enum([
  'AVAILABLE',
  'UPCOMING',
  'RESERVED',
  'USED',
  'EXPIRED',
  'REVOKED',
]);

export class CreateVoucherCampaignDto extends createZodDto(CampaignSchema) {}
export class UpdateVoucherCampaignDto extends createZodDto(
  CampaignSchema.partial().extend({ expectedUpdatedAt: DateSchema }),
) {}
export class VoucherCampaignVersionDto extends createZodDto(
  z.strictObject({ expectedUpdatedAt: DateSchema }),
) {}
export class GetVoucherCampaignsDto extends createZodDto(
  PageSchema.extend({
    keyword: z.string().trim().min(1).max(100).optional(),
    status: z.enum(['DRAFT', 'ACTIVE', 'PAUSED']).optional(),
  }),
) {}
export class GetPublicVoucherCampaignsDto extends createZodDto(PageSchema) {}
export class GetVoucherGrantsDto extends createZodDto(
  PageSchema.extend({
    source: z.enum(['CLAIM', 'GIFT']).optional(),
    sourceOrderId: z.uuid().optional(),
    status: VoucherWalletStatusSchema.optional(),
  }),
) {}
export class GetCustomerVouchersDto extends createZodDto(
  PageSchema.extend({
    status: VoucherWalletStatusSchema.optional(),
    orderId: z.uuid().optional(),
  }),
) {}
export class ClaimCustomerVoucherDto extends createZodDto(
  z.strictObject({ campaignId: z.uuid(), expectedCustomerId: z.uuid() }),
) {}
export class GiftCustomerVoucherDto extends createZodDto(
  z.strictObject({
    sourceOrderId: z.uuid(),
    reason: z.string().trim().min(2).max(500),
    idempotencyKey: z.string().trim().min(8).max(120),
  }),
) {}
export class RevokeCustomerVoucherDto extends createZodDto(
  z.strictObject({
    reason: z.string().trim().min(2).max(500),
    expectedUpdatedAt: DateSchema,
    idempotencyKey: z.string().trim().min(8).max(120),
  }),
) {}
