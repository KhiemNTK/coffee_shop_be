import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

export class GetManagementExceptionsDto extends createZodDto(
  z.object({
    kind: z.enum(['PAYMENT', 'CASH_EXPENSE', 'CASH_HANDOVER', 'FEEDBACK']),
    page: z.coerce.number().int().min(1).default(1),
    itemPerPage: z.coerce.number().int().min(1).max(50).default(20),
  }),
) {}
