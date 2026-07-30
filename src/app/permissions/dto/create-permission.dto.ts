import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

export const PermissionKeySchema = z
  .string()
  .trim()
  .regex(
    /^\/[a-z0-9-]+(?:_[a-z0-9-]+)+$/,
    'Permission key must match /resource_action format',
  )
  .max(120, 'Permission key must not exceed 120 characters');

export const CreatePermissionInputSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, 'Permission name is required')
    .max(120, 'Permission name must not exceed 120 characters'),
  key: PermissionKeySchema,
  description: z
    .string()
    .trim()
    .max(500, 'Description must not exceed 500 characters')
    .nullable()
    .optional(),
});

export class CreatePermissionDto extends createZodDto(
  CreatePermissionInputSchema,
) {}
