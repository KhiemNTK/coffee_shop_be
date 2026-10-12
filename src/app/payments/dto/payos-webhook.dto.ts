import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

export class PayosWebhookDto extends createZodDto(
  z.object({
    code: z.string().max(16),
    desc: z.string().max(512),
    success: z.boolean(),
    signature: z.string().regex(/^[a-f0-9]{64}$/),
    data: z
      .object({
        orderCode: z.number().int().positive().safe(),
        amount: z.number().int().nonnegative().safe(),
        currency: z.string().max(8),
        paymentLinkId: z.string().regex(/^[a-f0-9]{32}$/),
        reference: z.string().min(1).max(128),
        code: z.string().max(16),
        description: z.string().max(512),
        accountNumber: z.string().max(128),
        transactionDateTime: z.string().max(64),
        desc: z.string().max(512),
      })
      .catchall(z.union([z.string().max(512), z.number().finite(), z.null()]))
      .refine(
        (data) => Object.keys(data).length <= 64,
        'Too many payOS webhook fields',
      ),
  }),
) {}
