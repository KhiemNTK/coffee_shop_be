import { Decimal } from '@prisma/client/runtime/library';
import { z } from 'zod';

export const MoneyInputSchema = z.union([
  z
    .string()
    .trim()
    .regex(
      /^\d{1,16}(\.\d{1,2})?$/,
      'Money must have at most 16 integer digits and 2 decimal places.',
    ),
  z
    .number()
    .nonnegative()
    .refine(
      (value) =>
        value <= Number.MAX_SAFE_INTEGER / 100 &&
        new Decimal(value).decimalPlaces() <= 2,
      'Use a decimal string for large amounts; money supports at most 2 decimal places.',
    ),
]);

export const TaxRateInputSchema = MoneyInputSchema.refine(
  (value) => new Decimal(value).lte(100),
  'Tax rate must be between 0 and 100 with at most 2 decimal places.',
);
