import { z } from 'zod';
import { createZodDto } from 'nestjs-zod';
import { MoneyInputSchema } from '../../../common/validation/money.schema';

export const CreatePositionInputSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, 'Position name cannot be empty')
    .max(100, 'Position name is too long'),

  salary: MoneyInputSchema,
});

export class CreatePositionDto extends createZodDto(
  CreatePositionInputSchema,
) {}
