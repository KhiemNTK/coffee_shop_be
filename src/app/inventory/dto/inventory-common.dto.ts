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
  .datetime({ offset: true })
  .optional()
  .transform((value) => (value ? new Date(value) : undefined));

export const InventoryPaginationSchema = z.object({
  itemPerPage: z.coerce.number().min(1).max(100).default(10),
  page: z.coerce.number().min(1).default(1),
  select: z.string().optional(),
  keyword: z.string().trim().min(1).max(120).optional(),
});

export const RequiredIdempotencyKeySchema = z
  .string()
  .trim()
  .min(8, 'Idempotency key must be at least 8 characters')
  .max(120, 'Idempotency key must not exceed 120 characters');

export const IdempotencyKeySchema = RequiredIdempotencyKeySchema.optional();

export const MoneyInputSchema = z.union([
  z
    .string()
    .trim()
    .regex(/^\d+(\.\d{1,2})?$/, 'Invalid money value'),
  z.number().nonnegative(),
]);

const InventoryMovementBaseSchema = z.object({
  quantity: PositiveInventoryDecimalInputSchema,
  transactionDate: OptionalDateSchema,
  note: z.string().trim().min(3).max(500),
});

export const InventoryImportSchema = InventoryMovementBaseSchema.extend({
  unitPrice: MoneyInputSchema,
  idempotencyKey: IdempotencyKeySchema,
});

export const InventoryExportSchema = InventoryMovementBaseSchema.extend({
  idempotencyKey: IdempotencyKeySchema,
});

export const BulkInventoryImportItemSchema = InventoryMovementBaseSchema.extend(
  {
    inventoryItemId: z.uuid('Invalid UUID for inventory item'),
    unitPrice: MoneyInputSchema,
  },
);

export const BulkInventoryExportItemSchema = InventoryMovementBaseSchema.extend(
  {
    inventoryItemId: z.uuid('Invalid UUID for inventory item'),
  },
);

export const InventoryTransactionsQuerySchema =
  InventoryPaginationSchema.extend({
    inventoryItemId: z.uuid('Invalid UUID for inventory item').optional(),
    orderItemId: z.uuid('Invalid UUID for order item').optional(),
    type: z.enum(InventoryTxType).optional(),
    transactionFrom: OptionalDateSchema,
    transactionTo: OptionalDateSchema,
  });

export const InventoryWasteQuerySchema = InventoryPaginationSchema.pick({
  itemPerPage: true,
  page: true,
})
  .extend({
    inventoryItemId: z.uuid('Invalid UUID for inventory item').optional(),
    orderItemId: z.uuid('Invalid UUID for order item').optional(),
    createdFrom: OptionalDateSchema,
    createdTo: OptionalDateSchema,
  })
  .refine(
    ({ createdFrom, createdTo }) =>
      !createdFrom || !createdTo || createdFrom <= createdTo,
    {
      message: 'createdFrom must be before or equal to createdTo',
      path: ['createdFrom'],
    },
  );

export class InventoryImportDto extends createZodDto(InventoryImportSchema) {}

export class InventoryExportDto extends createZodDto(InventoryExportSchema) {}

export class BulkInventoryImportDto extends createZodDto(
  z.object({
    items: z
      .array(BulkInventoryImportItemSchema)
      .min(1, 'At least one inventory movement is required')
      .max(100, 'Cannot process more than 100 inventory movements'),
    idempotencyKey: IdempotencyKeySchema,
  }),
) {}

export class BulkInventoryExportDto extends createZodDto(
  z.object({
    items: z
      .array(BulkInventoryExportItemSchema)
      .min(1, 'At least one inventory movement is required')
      .max(100, 'Cannot process more than 100 inventory movements'),
    idempotencyKey: IdempotencyKeySchema,
  }),
) {}

export class GetInventoryTransactionsDto extends createZodDto(
  InventoryTransactionsQuerySchema,
) {}

export class GetInventoryWasteDto extends createZodDto(
  InventoryWasteQuerySchema,
) {}
