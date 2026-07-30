import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

export const CancelOrderItemSchema = z.object({
  reason: z
    .string()
    .trim()
    .max(255, { message: 'Cancel reason is too long' })
    .optional(),
});

export class CancelOrderItemDto extends createZodDto(CancelOrderItemSchema) {}
