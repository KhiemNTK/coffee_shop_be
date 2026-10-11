import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

export const OnlineOrderIntakeValueSchema = z
  .strictObject({
    pausedUntil: z.iso.datetime({ offset: true }).nullable(),
    reason: z.string().trim().min(1).max(255).nullable(),
  })
  .refine((value) => (value.pausedUntil === null) === (value.reason === null), {
    message:
      'A pause requires a reason; resuming requires both fields to be null.',
  });

export class UpdateOnlineOrderIntakeDto extends createZodDto(
  OnlineOrderIntakeValueSchema.safeExtend({
    expectedVersion: z.number().int().min(0),
  }),
) {}
