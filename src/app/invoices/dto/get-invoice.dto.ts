import { PaymentMethod, PaymentStatus } from '@prisma/client';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

const OptionalDateSchema = z
  .string()
  .datetime()
  .or(z.coerce.date())
  .optional()
  .transform((value) => (value ? new Date(value) : undefined));

export const GetInvoicesPaginationSchema = z.object({
  itemPerPage: z.coerce.number().min(1).max(100).default(10),
  page: z.coerce.number().min(1).default(1),
  select: z.string().optional(),
  paymentStatus: z.enum(PaymentStatus).optional(),
  paymentMethod: z.enum(PaymentMethod).optional(),
  orderSessionId: z.uuid('Invalid UUID for order session').optional(),
  employeeId: z.uuid('Invalid UUID for employee').optional(),
  shiftId: z.uuid('Invalid UUID for cashier shift').optional(),
  createdFrom: OptionalDateSchema,
  createdTo: OptionalDateSchema,
});

export class GetInvoicesPaginationDto extends createZodDto(
  GetInvoicesPaginationSchema,
) {}
