import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

export class RemakeOrderItemDto extends createZodDto(
  z.strictObject({
    reason: z.string().trim().min(3).max(500),
    idempotencyKey: z.string().trim().min(8).max(120),
  }),
) {}
