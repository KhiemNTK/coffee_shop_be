import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

const OptionalReportDateSchema = z
  .string()
  .datetime({ offset: true })
  .optional()
  .transform((value) => (value ? new Date(value) : undefined));

export class GetDashboardReportDto extends createZodDto(
  z.object({
    from: OptionalReportDateSchema,
    to: OptionalReportDateSchema,
    timeZone: z.string().trim().min(1).max(64).default('Asia/Ho_Chi_Minh'),
    granularity: z.enum(['hour', 'day']).default('day'),
    topLimit: z.coerce.number().int().min(1).max(50).default(10),
    lowStockThreshold: z.coerce.number().min(0).max(1_000_000).default(5),
  }),
) {}
