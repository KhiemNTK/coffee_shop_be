import { PaymentAttemptStatus, PaymentProvider } from '@prisma/client';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

export class CreatePaymentAttemptDto extends createZodDto(
  z.object({
    idempotencyKey: z.string().trim().min(8).max(120),
    locale: z.enum(['vn', 'en']).default('vn'),
    bankCode: z
      .string()
      .trim()
      .min(2)
      .max(20)
      .regex(/^[A-Za-z0-9_-]+$/)
      .optional(),
    closeSessionAfterPayment: z.boolean().default(true),
  }),
) {}

export class GetPaymentAttemptsDto extends createZodDto(
  z.object({
    itemPerPage: z.coerce.number().int().min(1).max(100).default(20),
    page: z.coerce.number().int().min(1).default(1),
    provider: z.enum(PaymentProvider).optional(),
    status: z.enum(PaymentAttemptStatus).optional(),
  }),
) {}
