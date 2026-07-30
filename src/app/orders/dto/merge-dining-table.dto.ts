import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

export const MergeDiningTableSchema = z
  .object({
    sourceTableIds: z
      .array(z.uuid({ message: 'Each source table ID must be a valid UUID' }))
      .min(1, {
        message: 'At least one source table must be selected for merging',
      })
      .max(20, {
        message: 'Cannot merge more than 20 tables at once',
      }),

    destinationTableId: z.uuid({
      message: 'destinationTableId must be a valid UUID',
    }),
  })
  .refine((data) => !data.sourceTableIds.includes(data.destinationTableId), {
    message:
      'Destination table cannot be included within the source tables array',
    path: ['destinationTableId'],
  })
  .refine(
    (data) => new Set(data.sourceTableIds).size === data.sourceTableIds.length,
    {
      message: 'Duplicate source tables are not allowed',
      path: ['sourceTableIds'],
    },
  );

export class MergeDiningTableDto extends createZodDto(MergeDiningTableSchema) {}
