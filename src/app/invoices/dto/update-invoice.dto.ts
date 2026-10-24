import { PaymentMethod, PaymentStatus } from '@prisma/client';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { MoneyInputSchema } from '../../../common/validation/money.schema';

export const UpdateInvoicePaymentInputSchema = z.object({
  paymentStatus: z.literal(PaymentStatus.PAID),
  paymentMethod: z.enum([PaymentMethod.CASH, PaymentMethod.CARD]).optional(),
  amountTendered: MoneyInputSchema.optional(),
  closeSessionAfterPayment: z.boolean().optional().default(true),
});

export class UpdateInvoicePaymentDto extends createZodDto(
  UpdateInvoicePaymentInputSchema,
) {}
