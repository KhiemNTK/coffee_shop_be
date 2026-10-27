import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

export const OpenSessionSchema = z.object({
  idempotencyKey: z.uuid(),
  tableId: z
    .uuid({ message: 'tableId must be a valid UUID' })
    .nullish()
    .default(null),
  guestCount: z
    .number()
    .int()
    .positive({ message: 'Guest count must be positive' })
    .optional(),
});

export class OpenSessionDto extends createZodDto(OpenSessionSchema) {}
