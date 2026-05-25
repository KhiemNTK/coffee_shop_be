import { createZodDto } from 'nestjs-zod';
import z from 'zod';

export class IDDto extends createZodDto(
  z.object({
    id: z.uuid(),
  }),
) {}
