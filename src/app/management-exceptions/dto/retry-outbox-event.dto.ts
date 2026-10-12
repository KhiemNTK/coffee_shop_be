import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

export class RetryOutboxEventDto extends createZodDto(
  z.object({
    reason: z.string().trim().min(3).max(500),
    expectedAvailableAt: z.iso.datetime(),
    idempotencyKey: z.string().trim().min(8).max(120),
  }),
) {}
