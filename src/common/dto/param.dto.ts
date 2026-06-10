import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

export class IDDto extends createZodDto(
  z.object({
    id: z.uuid(),
  }),
) {}
export class ExportExcelDto extends createZodDto(
  z.object({
    ids: z
      .preprocess((val) => {
        if (val === undefined || val === null || val === '') {
          return undefined;
        }
        if (typeof val === 'string') {
          return [val];
        }
        return val;
      }, z.array(z.uuid()).optional())
      .nullable()
      .default(null),

    select: z
      .string()
      .nullish()
      .default(null)
      .describe(
        'fields to export, separated by comma, example: id,name,created_at',
      ),
  }),
) {}
