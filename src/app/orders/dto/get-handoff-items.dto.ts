import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

export class GetHandoffItemsDto extends createZodDto(
  z.object({
    page: z.coerce.number().int().min(1).default(1),
    itemPerPage: z.coerce.number().int().min(1).max(100).default(50),
  }),
) {}
