import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

export const TransferDiningTableSchema = z
  .object({
    fromTableId: z.uuid({ message: 'fromTableId must be a valid UUID' }),
    toTableId: z.uuid({ message: 'toTableId must be a valid UUID' }),
  })
  .refine((data) => data.fromTableId !== data.toTableId, {
    message: 'Source and destination tables cannot be identical',
    path: ['toTableId'],
  });

export class TransferDiningTableDto extends createZodDto(
  TransferDiningTableSchema,
) {}
