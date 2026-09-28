import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

const PublicOrderItemSchema = z.object({
  menuItemId: z.uuid(),
  quantity: z.number().int().min(1).max(20),
  note: z.string().trim().max(255).optional(),
  optionIds: z
    .array(z.uuid())
    .max(20)
    .refine(
      (ids) => new Set(ids).size === ids.length,
      'Duplicate menu options are not allowed',
    )
    .optional(),
});

export class CreateOnlineOrderDto extends createZodDto(
  z
    .object({
      clientRequestId: z.uuid(),
      turnstileToken: z.string().min(1).max(2048).optional(),
      pickupName: z.string().trim().min(2).max(80),
      phoneNumber: z
        .string()
        .trim()
        .regex(/^\+?[0-9]{8,15}$/, 'Invalid phone number'),
      pickupAt: z.iso
        .datetime({ offset: true })
        .transform((value) => new Date(value))
        .optional(),
      maxSubtotal: z
        .string()
        .trim()
        .regex(/^(0|[1-9]\d{0,15})(\.\d{1,2})?$/)
        .optional(),
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

const OnlineOrderAccessSchema = z.object({
  requestId: z.uuid(),
  accessToken: z.string().regex(/^[0-9a-f]{64}$/),
});

export class OnlineOrderAccessDto extends createZodDto(
  OnlineOrderAccessSchema,
) {}

export class ReorderTemplateDto extends createZodDto(
  OnlineOrderAccessSchema.extend({
    accessToken: OnlineOrderAccessSchema.shape.accessToken.optional(),
    reorderToken: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .optional(),
  }).refine(
    (value) => Boolean(value.accessToken) !== Boolean(value.reorderToken),
    {
      message: 'Provide exactly one reorder credential.',
    },
  ),
) {}

export class RevokeReorderKeyDto extends createZodDto(
  z.object({
    requestId: OnlineOrderAccessSchema.shape.requestId,
    reorderToken: z.string().regex(/^[0-9a-f]{64}$/),
  }),
) {}

export class GetPendingOnlineOrdersDto extends createZodDto(
  z.object({
    page: z.coerce.number().int().min(1).default(1),
    itemPerPage: z.coerce.number().int().min(1).max(50).default(20),
    overdueOnly: z
      .enum(['true', 'false'])
      .transform((value) => value === 'true')
      .optional(),
  }),
) {}

export class GetPickupSlotsDto extends createZodDto(
  z.object({ date: z.iso.date() }),
) {}

export class RejectOnlineOrderDto extends createZodDto(
  z.object({ reason: z.string().trim().min(2).max(200) }),
) {}

export class CancelAcceptedOnlineOrderDto extends createZodDto(
  z.object({ reason: z.string().trim().min(2).max(200) }),
) {}

export class CollectOnlineOrderDto extends createZodDto(
  z.object({
    accessToken: z.string().regex(/^[0-9a-f]{64}$/),
    amountTendered: z
      .string()
      .trim()
      .regex(/^(0|[1-9]\d{0,15})(\.\d{1,2})?$/),
    idempotencyKey: z.string().trim().min(8).max(120),
  }),
) {}
