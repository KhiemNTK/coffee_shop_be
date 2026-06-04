import { z } from 'zod';
import { createZodDto } from 'nestjs-zod';

export const CreatePositionInputSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, 'Position name cannot be empty')
    .max(100, 'Position name is too long'),

  salary: z.coerce
    .number()
    .nonnegative('Salary must be a positive number or zero'),
});

export class CreatePositionDto extends createZodDto(
  CreatePositionInputSchema,
) {}
