import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { PickupCodeSchema } from './pickup-code.dto';

export class SubmitTakeawayFeedbackDto extends createZodDto(
  PickupCodeSchema.extend({
    rating: z.number().int().min(1).max(5),
    comment: z.string().trim().max(500).optional(),
  }),
) {}

const OptionalDateSchema = z
  .string()
  .datetime({ offset: true })
  .optional()
  .transform((value) => (value ? new Date(value) : undefined));

const FeedbackPeriodSchema = z
  .object({
    from: OptionalDateSchema,
    to: OptionalDateSchema,
  })
  .refine(({ from, to }) => !from || !to || from <= to, {
    message: 'from must not be after to.',
    path: ['to'],
  });

export class GetTakeawayFeedbackSummaryDto extends createZodDto(
  FeedbackPeriodSchema,
) {}

export class GetTakeawayFeedbackDto extends createZodDto(
  FeedbackPeriodSchema.safeExtend({
    page: z.coerce.number().int().min(1).default(1),
    itemPerPage: z.coerce.number().int().min(1).max(100).default(20),
    rating: z.coerce.number().int().min(1).max(5).optional(),
  }),
) {}
