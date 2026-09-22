import {
  PaymentReconciliationIncidentStatus,
  PaymentReconciliationIncidentType,
  PaymentRefundStatus,
  PaymentRefundType,
} from '@prisma/client';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

const MoneySchema = z
  .string()
  .trim()
  .regex(/^(?:0|[1-9]\d{0,15})(?:\.\d{1,2})?$/, 'Invalid money value')
  .refine((value) => value !== '0' && value !== '0.0' && value !== '0.00', {
    message: 'Amount must be greater than zero',
  });

const PaginationSchema = {
  itemPerPage: z.coerce.number().int().min(1).max(100).default(20),
  page: z.coerce.number().int().min(1).default(1),
};

export class CreatePaymentRefundDto extends createZodDto(
  z.object({
    amount: MoneySchema,
    reason: z.string().trim().min(3).max(500),
    idempotencyKey: z.string().trim().min(8).max(120),
  }),
) {}

export class GetPaymentRefundsDto extends createZodDto(
  z.object({
    ...PaginationSchema,
    status: z.enum(PaymentRefundStatus).optional(),
    type: z.enum(PaymentRefundType).optional(),
  }),
) {}

export class GetPaymentIncidentsDto extends createZodDto(
  z.object({
    ...PaginationSchema,
    status: z.enum(PaymentReconciliationIncidentStatus).optional(),
    type: z.enum(PaymentReconciliationIncidentType).optional(),
  }),
) {}

export class ResolvePaymentIncidentDto extends createZodDto(
  z.object({
    action: z.enum(['RESOLVE', 'IGNORE']),
    resolutionNote: z.string().trim().min(3).max(500),
  }),
) {}
