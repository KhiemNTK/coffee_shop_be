import { CreateEmployeeInputSchema } from './create-employee.dto';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

export const UpdateEmployeeInputSchema = CreateEmployeeInputSchema.partial()
  .extend({
    expectedUpdatedAt: z.iso.datetime({ offset: true }),
    isActive: z.boolean().optional(),
  })
  .refine(
    ({ expectedUpdatedAt: _revision, ...changes }) =>
      Object.keys(changes).length > 0,
    {
      message: 'At least one profile field must be provided.',
    },
  );
export class UpdateEmployeeDto extends createZodDto(
  UpdateEmployeeInputSchema,
) {}
