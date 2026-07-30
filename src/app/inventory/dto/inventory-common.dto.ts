import { InventoryTxType } from '@prisma/client';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

export const InventoryDecimalInputSchema = z.union([
  z
    .string()
    .trim()
    .regex(/^\d+(\.\d{1,4})?$/, 'Invalid decimal value'),
  z.number().nonnegative(),
]);

export const PositiveInventoryDecimalInputSchema =
  InventoryDecimalInputSchema.refine((value) => Number(value) > 0, {
    message: 'Value must be greater than 0',
  });

export const OptionalDateSchema = z
  .string()
  .datetime()
  .or(z.coerce.date())
  .optional()
  .transform((value) => (value ? new Date(value) : undefined));

export const InventoryPaginationSchema = z.object({
  itemPerPage: z.coerce.number().min(1).max(100).default(10),
  page: z.coerce.number().min(1).default(1),
  select: z.string().optional(),
  keyword: z.string().trim().min(1).max(120).optional(),
});

export const IdempotencyKeySchema = z
  .string()
  .trim()
  .min(8, 'Idempotency key must be at least 8 characters')
  .max(120, 'Idempotency key must not exceed 120 characters')
  .optional();

export const InventoryMovementSchema = z.object({
  quantity: PositiveInventoryDecimalInputSchema,
  unitPrice: InventoryDecimalInputSchema.optional(),
  transactionDate: OptionalDateSchema,
  note: z.string().trim().max(500).optional(),
  idempotencyKey: IdempotencyKeySchema,
});

export const BulkInventoryMovementItemSchema = InventoryMovementSchema.extend({
  inventoryItemId: z.uuid('Invalid UUID for inventory item'),
});

export const InventoryTransactionsQuerySchema =
  InventoryPaginationSchema.extend({
    inventoryItemId: z.uuid('Invalid UUID for inventory item').optional(),
    type: z.enum(InventoryTxType).optional(),
    transactionFrom: OptionalDateSchema,
    transactionTo: OptionalDateSchema,
  });

export class InventoryMovementDto extends createZodDto(
  InventoryMovementSchema,
) {}

export class BulkInventoryMovementDto extends createZodDto(
  z.object({
    items: z
      .array(BulkInventoryMovementItemSchema)
      .min(1, 'At least one inventory movement is required')
      .max(100, 'Cannot process more than 100 inventory movements'),
    idempotencyKey: IdempotencyKeySchema,
  }),
) {}

export class GetInventoryTransactionsDto extends createZodDto(
  InventoryTransactionsQuerySchema,
) {}
