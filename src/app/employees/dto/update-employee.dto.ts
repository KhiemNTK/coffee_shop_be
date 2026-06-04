import { CreateEmployeeInputSchema } from './create-employee.dto';
import { createZodDto } from 'nestjs-zod';

export const UpdateEmployeeInputSchema = CreateEmployeeInputSchema.partial();
export class UpdateEmployeeDto extends createZodDto(
  UpdateEmployeeInputSchema,
) {}
