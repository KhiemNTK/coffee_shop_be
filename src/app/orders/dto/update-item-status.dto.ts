import { ServeStatus } from '@prisma/client';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

export const UpdateOrderItemStatusSchema = z.object({
  serveStatus: z.nativeEnum(ServeStatus, {
    message: 'serveStatus must be a valid ServeStatus',
  }),
});

export class UpdateOrderItemStatusDto extends createZodDto(
  UpdateOrderItemStatusSchema,
) {}
