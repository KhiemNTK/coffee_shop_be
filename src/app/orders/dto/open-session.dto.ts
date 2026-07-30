import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

export const OpenSessionSchema = z.object({
  tableId: z
    .uuid({ message: 'tableId must be a valid UUID' })
    .nullish()
    .default(null),
  guestCount: z
    .number()
    .int()
    .positive({ message: 'Guest count must be positive' })
    .optional(),
  shiftId: z
    .uuid({ message: 'shiftId must be a valid UUID' })
    .nullish()
    .default(null),
});

export class OpenSessionDto extends createZodDto(OpenSessionSchema) {}
