import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

export const ReplaceEmployeeRolesInputSchema = z.object({
  roleIds: z
    .array(z.uuid('Invalid UUID for role'))
    .max(20, 'An employee must not have more than 20 roles')
    .default([]),
});

export class ReplaceEmployeeRolesDto extends createZodDto(
  ReplaceEmployeeRolesInputSchema,
) {}
