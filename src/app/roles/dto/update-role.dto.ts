import { createZodDto } from 'nestjs-zod';
import { RoleMetadataInputSchema } from './create-role.dto';
import { z } from 'zod';

export const UpdateRoleInputSchema = RoleMetadataInputSchema.partial()
  .extend({
    expectedUpdatedAt: z.iso
      .datetime({ offset: true })
      .transform((value) => new Date(value)),
  })
  .refine(
    (value) => value.name !== undefined || value.description !== undefined,
    {
      message: 'At least one metadata field is required',
    },
  );
export class UpdateRoleDto extends createZodDto(UpdateRoleInputSchema) {}
