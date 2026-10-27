import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { PromotionDateSchema } from './promotion-common.dto';

export class UpdatePromotionStorefrontDto extends createZodDto(
  z.strictObject({
    showOnStorefront: z.boolean(),
    storefrontDescription: z.string().trim().min(1).max(500).nullable(),
    expectedUpdatedAt: PromotionDateSchema,
  }),
) {}
