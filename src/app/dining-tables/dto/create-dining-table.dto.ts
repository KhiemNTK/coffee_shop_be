import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

export const CreateDiningTableSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, { message: 'Table name cannot be empty' })
    .max(50, { message: 'Table name exceeds maximum length of 50 characters' }),
});

export class CreateDiningTableDto extends createZodDto(
  CreateDiningTableSchema,
) {}

export const UpdateDiningTableSchema = CreateDiningTableSchema.partial();
export class UpdateDiningTableDto extends createZodDto(
  UpdateDiningTableSchema,
) {}
