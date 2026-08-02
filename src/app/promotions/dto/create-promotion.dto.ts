import { createZodDto } from 'nestjs-zod';
import { PromotionBaseSchema } from './promotion-common.dto';

export class CreatePromotionDto extends createZodDto(PromotionBaseSchema) {}
