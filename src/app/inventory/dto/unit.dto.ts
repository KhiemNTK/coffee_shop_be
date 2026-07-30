import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { InventoryPaginationSchema } from './inventory-common.dto';

export const UnitSchema = z.object({
  name: z.string().trim().min(1).max(80),
});

export class CreateUnitDto extends createZodDto(UnitSchema) {}

export class UpdateUnitDto extends createZodDto(UnitSchema.partial()) {}

export class GetUnitsDto extends createZodDto(InventoryPaginationSchema) {}
