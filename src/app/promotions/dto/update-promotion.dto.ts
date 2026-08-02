import { createZodDto } from 'nestjs-zod';
import { PromotionBaseSchema } from './promotion-common.dto';

export class UpdatePromotionDto extends createZodDto(
  PromotionBaseSchema.partial(),
) {}
