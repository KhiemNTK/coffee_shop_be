import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

export class CreateCashRefundDto extends createZodDto(
  z.strictObject({
    expectedShiftId: z.uuid(),
    amount: z
      .string()
      .trim()
      .regex(/^(?:0|[1-9]\d{0,15})(?:\.\d{1,2})?$/)
      .refine(
        (value) => !/^0(?:\.0{1,2})?$/.test(value),
        'Amount must be positive',
      ),
    reason: z.string().trim().min(3).max(500),
    idempotencyKey: z.string().trim().min(8).max(120),
  }),
) {}

export class GetCashRefundsDto extends createZodDto(
  z.object({
    page: z.coerce.number().int().min(1).default(1),
    itemPerPage: z.coerce.number().int().min(1).max(100).default(20),
  }),
) {}
