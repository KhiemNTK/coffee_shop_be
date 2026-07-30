import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import {
  InventoryDecimalInputSchema,
  InventoryPaginationSchema,
} from './inventory-common.dto';

export const CreateInventoryItemSchema = z.object({
  name: z.string().trim().min(1).max(160),
  stock: InventoryDecimalInputSchema.optional(),
  categoryId: z.uuid('Invalid UUID for inventory category'),
  unitId: z.uuid('Invalid UUID for unit'),
});

export const UpdateInventoryItemSchema = z.object({
  name: z.string().trim().min(1).max(160).optional(),
  categoryId: z.uuid('Invalid UUID for inventory category').optional(),
  unitId: z.uuid('Invalid UUID for unit').optional(),
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
