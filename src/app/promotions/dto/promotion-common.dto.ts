import { DiscountType } from '@prisma/client';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

export const PromotionDecimalInputSchema = z.union([
  z
    .string()
    .trim()
    .regex(/^\d+(\.\d{1,4})?$/, 'Invalid decimal value'),
  z.number().nonnegative(),
]);

export const PromotionDateSchema = z
  .string()
  .datetime()
  .or(z.coerce.date())
  .transform((value) => new Date(value));

export const OptionalPromotionDateSchema = PromotionDateSchema.optional();

export const PromotionSortFieldSchema = z
  .enum(['name', 'startDate', 'endDate', 'createdAt', 'updatedAt'])
  .default('createdAt');

export const PromotionStatusSchema = z.enum([
  'ACTIVE',
  'UPCOMING',
  'EXPIRED',
  'DELETED',
]);

export const PromotionBaseSchema = z.object({
  name: z.string().trim().min(1).max(100),
  startDate: PromotionDateSchema,
  endDate: PromotionDateSchema,
  discountType: z.enum(DiscountType),
  discountValue: PromotionDecimalInputSchema,
  maxDiscount: PromotionDecimalInputSchema.nullish(),
});

export const SearchPromotionsSchema = z.object({
  itemPerPage: z.coerce.number().min(1).max(100).default(20),
  page: z.coerce.number().min(1).default(1),
  select: z.string().optional(),
  keyword: z.string().trim().min(1).max(100).optional(),
  discountType: z.enum(DiscountType).optional(),
  status: PromotionStatusSchema.optional(),
  validAt: OptionalPromotionDateSchema,
  includeDeleted: z.coerce.boolean().optional().default(false),
  sortBy: PromotionSortFieldSchema,
  sortOrder: z.enum(['asc', 'desc']).default('desc'),
});

export const ActivePromotionsSchema = z.object({
  at: OptionalPromotionDateSchema,
  subTotal: PromotionDecimalInputSchema.optional(),
});

export class SearchPromotionsDto extends createZodDto(SearchPromotionsSchema) {}

export class GetActivePromotionsDto extends createZodDto(
  ActivePromotionsSchema,
) {}
