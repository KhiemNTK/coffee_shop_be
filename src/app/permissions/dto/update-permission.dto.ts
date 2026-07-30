import { createZodDto } from 'nestjs-zod';
import { CreatePermissionInputSchema } from './create-permission.dto';

export const UpdatePermissionInputSchema =
  CreatePermissionInputSchema.partial();

export class UpdatePermissionDto extends createZodDto(
  UpdatePermissionInputSchema,
) {}
