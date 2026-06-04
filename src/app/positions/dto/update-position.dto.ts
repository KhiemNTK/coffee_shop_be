import { createZodDto } from 'nestjs-zod';
import { CreatePositionInputSchema } from './create-position.dto';

export const UpdatePositionInputSchema = CreatePositionInputSchema.partial();

export class UpdatePositionDto extends createZodDto(
  UpdatePositionInputSchema,
) {}
