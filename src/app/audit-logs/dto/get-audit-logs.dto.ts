import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

const DateSchema = z
  .string()
  .datetime({ offset: true })
  .transform((value) => new Date(value));

export class GetAuditLogsDto extends createZodDto(
  z
    .object({
      page: z.coerce.number().int().min(1).default(1),
      itemPerPage: z.coerce.number().int().min(1).max(50).default(20),
      employeeId: z.uuid().optional(),
      actionType: z.string().trim().min(1).max(100).optional(),
      requestId: z.string().trim().min(1).max(100).optional(),
      from: DateSchema.optional(),
      to: DateSchema.optional(),
    })
    .refine(({ from, to }) => !from || !to || from <= to, {
      message: 'from must be before or equal to to',
      path: ['from'],
    }),
) {}
