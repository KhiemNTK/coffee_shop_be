import { z } from 'zod';

export const MenuPaginationSchema = z.object({
  itemPerPage: z.coerce.number().int().min(1).max(100).default(20),
  page: z.coerce.number().int().min(1).default(1),
  keyword: z.string().trim().min(1).max(120).optional(),
});

export const MenuMoneyInputSchema = z.union([
  z
    .string()
    .trim()
    .regex(
      /^(0|[1-9]\d{0,14})(\.\d{1,2})?$/,
      'Price must be a non-negative decimal with at most 2 decimal places',
    ),
  z.number().finite().nonnegative().max(999_999_999_999_999).multipleOf(0.01),
]);

export const MenuQuantityInputSchema = z.union([
  z
    .string()
    .trim()
    .regex(
      /^(0|[1-9]\d{0,13})(\.\d{1,4})?$/,
      'Quantity must be greater than 0 with at most 4 decimal places',
    )
    .refine((value) => Number(value) > 0, {
      message: 'Quantity must be greater than 0',
    }),
  z.number().finite().positive().max(99_999_999_999_999).multipleOf(0.0001),
]);

export const OptionalBooleanQuerySchema = z.preprocess((value) => {
  if (value === 'true') return true;
  if (value === 'false') return false;
  return value;
}, z.boolean().optional());

export const NonEmptyUpdateSchema = <T extends z.ZodRawShape>(shape: T) =>
  z.object(shape).refine((value) => Object.keys(value).length > 0, {
    message: 'At least one field must be provided',
  });
