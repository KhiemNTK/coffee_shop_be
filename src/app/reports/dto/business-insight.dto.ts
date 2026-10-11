import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { BUSINESS_INSIGHT_MAX_RANGE_DAYS } from '../business-insight.schema';

export const CreateBusinessInsightSchema = z
  .strictObject({
    clientRequestId: z.uuid(),
    from: z.iso.datetime({ offset: true }),
    to: z.iso.datetime({ offset: true }),
    timeZone: z.literal('Asia/Ho_Chi_Minh').default('Asia/Ho_Chi_Minh'),
  })
  .refine(({ from, to }) => {
    const duration = Date.parse(to) - Date.parse(from);
    return (
      duration > 0 && duration <= BUSINESS_INSIGHT_MAX_RANGE_DAYS * 86_400_000
    );
  }, 'Choose a positive period of at most 31 days.');

export class CreateBusinessInsightDto extends createZodDto(
  CreateBusinessInsightSchema,
) {}
export class BusinessInsightIdDto extends createZodDto(
  z.strictObject({ id: z.string().regex(/^[a-f0-9]{64}$/) }),
) {}
