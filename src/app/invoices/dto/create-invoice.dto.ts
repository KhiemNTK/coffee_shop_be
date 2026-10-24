import { PaymentMethod } from '@prisma/client';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import {
  MoneyInputSchema,
  TaxRateInputSchema,
} from '../../../common/validation/money.schema';

const InvoiceItemIdsSchema = z
  .array(z.uuid('Invalid UUID for order item'))
  .min(1, 'At least one order item is required')
  .max(300, 'Cannot invoice more than 300 order items')
  .optional();

export const CreateInvoiceInputSchema = z.object({
  orderSessionId: z.uuid('Invalid UUID for order session'),
  orderItemIds: InvoiceItemIdsSchema,
  promotionId: z.uuid('Invalid UUID for promotion').nullable().optional(),
  taxRate: TaxRateInputSchema.optional(),
  quoteFingerprint: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
  expectedTotal: MoneyInputSchema.optional(),
});

export const CheckoutInvoiceInputSchema = CreateInvoiceInputSchema.extend({
  paymentMethod: z.enum(PaymentMethod),
  amountTendered: MoneyInputSchema.optional(),
  closeSessionAfterPayment: z.boolean().optional().default(true),
  idempotencyKey: z
    .string()
    .trim()
    .min(8, 'Idempotency key must be at least 8 characters')
    .max(120, 'Idempotency key must not exceed 120 characters')
    .optional(),
});

export class CreateInvoiceDto extends createZodDto(CreateInvoiceInputSchema) {}

export class CheckoutInvoiceDto extends createZodDto(
  CheckoutInvoiceInputSchema,
) {}
