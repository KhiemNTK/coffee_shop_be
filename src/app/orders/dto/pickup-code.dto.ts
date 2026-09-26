import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

export const PickupCodeSchema = z.object({
  invoiceId: z.uuid(),
  code: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
});

export class PickupCodeDto extends createZodDto(PickupCodeSchema) {}

export class PickupCurrentCodeDto extends createZodDto(
  PickupCodeSchema.pick({ code: true }),
) {}

export class PickupHandoffDto extends createZodDto(
  PickupCodeSchema.extend({ itemId: z.uuid() }),
) {}
