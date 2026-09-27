import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

const PublicOrderItemSchema = z.object({
  menuItemId: z.uuid(),
  quantity: z.number().int().min(1).max(20),
  note: z.string().trim().max(255).optional(),
});

export class CreateOnlineOrderDto extends createZodDto(
  z
    .object({
      clientRequestId: z.uuid(),
      pickupName: z.string().trim().min(2).max(80),
      phoneNumber: z
        .string()
        .trim()
        .regex(/^\+?[0-9]{8,15}$/, 'Invalid phone number'),
      items: z.array(PublicOrderItemSchema).min(1).max(20),
    })
    .refine(
      ({ items }) => items.reduce((sum, item) => sum + item.quantity, 0) <= 50,
      {
        message: 'An online order cannot contain more than 50 units.',
        path: ['items'],
      },
    ),
) {}

export class OnlineOrderAccessDto extends createZodDto(
  z.object({
    requestId: z.uuid(),
    accessToken: z.string().regex(/^[0-9a-f]{64}$/),
  }),
) {}

export class GetPendingOnlineOrdersDto extends createZodDto(
  z.object({
    page: z.coerce.number().int().min(1).default(1),
    itemPerPage: z.coerce.number().int().min(1).max(50).default(20),
  }),
) {}

export class RejectOnlineOrderDto extends createZodDto(
  z.object({ reason: z.string().trim().min(2).max(200) }),
) {}
