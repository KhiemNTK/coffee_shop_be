import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { InventoryPaginationSchema } from './inventory-common.dto';

export const InventoryCategorySchema = z.object({
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(500).nullable().optional(),
});

export class CreateInventoryCategoryDto extends createZodDto(
  InventoryCategorySchema,
) {}

export class UpdateInventoryCategoryDto extends createZodDto(
  InventoryCategorySchema.partial(),
) {}

export class GetInventoryCategoriesDto extends createZodDto(
  InventoryPaginationSchema,
) {}
