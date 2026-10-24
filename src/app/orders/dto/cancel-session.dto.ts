import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

export class CancelSessionDto extends createZodDto(
  z.object({
    reason: z.string().trim().min(3).max(500),
  }),
) {}
