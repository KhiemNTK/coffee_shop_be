import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import {
  InventoryDecimalInputSchema,
  InventoryPaginationSchema,
  MoneyInputSchema,
} from './inventory-common.dto';

export const CreateInventoryItemSchema = z
  .object({
    name: z.string().trim().min(1).max(160),
    stock: InventoryDecimalInputSchema.optional(),
    initialUnitCost: MoneyInputSchema.optional(),
    reorderPoint: InventoryDecimalInputSchema.optional(),
    categoryId: z.uuid('Invalid UUID for inventory category'),
    unitId: z.uuid('Invalid UUID for unit'),
  })
  .superRefine(({ stock, initialUnitCost }, context) => {
    if (
      stock !== undefined &&
      Number(stock) > 0 &&
      initialUnitCost === undefined
    ) {
      context.addIssue({
        code: 'custom',
        path: ['initialUnitCost'],
        message:
          'initialUnitCost is required when initial stock is greater than 0',
      });
    }
  });

export const UpdateInventoryItemSchema = z.object({
  name: z.string().trim().min(1).max(160).optional(),
  categoryId: z.uuid('Invalid UUID for inventory category').optional(),
  unitId: z.uuid('Invalid UUID for unit').optional(),
  reorderPoint: InventoryDecimalInputSchema.optional(),
});

export class CreateInventoryItemDto extends createZodDto(
  CreateInventoryItemSchema,
) {}

export class UpdateInventoryItemDto extends createZodDto(
  UpdateInventoryItemSchema,
) {}

export class GetInventoryItemsDto extends createZodDto(
  InventoryPaginationSchema.extend({
    categoryId: z.uuid('Invalid UUID for inventory category').optional(),
    unitId: z.uuid('Invalid UUID for unit').optional(),
    lowStockOnly: z.coerce.boolean().optional().default(false),
    maxStock: InventoryDecimalInputSchema.optional(),
  }),
) {}

export class GetInventoryReorderAlertsDto extends createZodDto(
  InventoryPaginationSchema.pick({
    itemPerPage: true,
    page: true,
    keyword: true,
  }).extend({
    categoryId: z.uuid('Invalid UUID for inventory category').optional(),
  }),
) {}
