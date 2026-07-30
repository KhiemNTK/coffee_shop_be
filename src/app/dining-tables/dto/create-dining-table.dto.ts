import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { TableStatus } from '@prisma/client';

export const CreateDiningTableSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, { message: 'Table name cannot be empty' })
    .max(50, { message: 'Table name exceeds maximum length of 50 characters' }),

  status: z
    .enum(TableStatus)
    .default(TableStatus.EMPTY)
    .describe('Initial status of the physical table'),
});

export class CreateDiningTableDto extends createZodDto(
  CreateDiningTableSchema,
) {}

// For Update DTO, simply make all fields optional using Zod's .partial()
export const UpdateDiningTableSchema = CreateDiningTableSchema.partial();
export class UpdateDiningTableDto extends createZodDto(
  UpdateDiningTableSchema,
) {}
