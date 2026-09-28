import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

export class RecommendOnlineItemsDto extends createZodDto(
  z.object({
    clientRequestId: z.uuid(),
    menuItemIds: z
      .array(z.uuid())
      .min(1)
      .max(10)
      .refine(
        (ids) => new Set(ids).size === ids.length,
        'Duplicate menu items',
      ),
  }),
) {}

export class RecommendationExperimentDto extends createZodDto(
  z
    .object({
      from: z.iso
        .datetime({ offset: true })
        .transform((value) => new Date(value)),
      to: z.iso
        .datetime({ offset: true })
        .transform((value) => new Date(value)),
    })
    .refine(
      ({ from, to }) =>
        to > from && to.getTime() - from.getTime() <= 90 * 86_400_000,
      {
        message: 'Choose a positive period of at most 90 days.',
      },
    ),
) {}
