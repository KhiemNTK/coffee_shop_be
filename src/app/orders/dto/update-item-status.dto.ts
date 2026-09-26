import { ServeStatus } from '@prisma/client';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

export const UpdateOrderItemStatusSchema = z.object({
  serveStatus: z.enum(
    [ServeStatus.COOKING, ServeStatus.READY, ServeStatus.SERVED],
    {
      message: 'serveStatus must be COOKING, READY or SERVED',
    },
  ),
});

export class UpdateOrderItemStatusDto extends createZodDto(
  UpdateOrderItemStatusSchema,
) {}
