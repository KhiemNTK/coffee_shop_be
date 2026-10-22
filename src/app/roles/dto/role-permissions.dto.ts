import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

export const ReplaceRolePermissionsInputSchema = z.object({
  permissionIds: z
    .array(z.uuid('Invalid UUID for permission'))
    .max(200, 'A role must not have more than 200 permissions'),
  expectedPermissionIds: z.array(z.uuid()).max(200).optional(),
});

export class ReplaceRolePermissionsDto extends createZodDto(
  ReplaceRolePermissionsInputSchema,
) {}
