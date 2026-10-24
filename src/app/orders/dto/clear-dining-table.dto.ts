import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

export class ClearDiningTableDto extends createZodDto(
  z.object({
    expectedOrderSessionId: z.uuid().nullable(),
    reason: z.string().trim().min(3).max(500),
  }),
) {}
