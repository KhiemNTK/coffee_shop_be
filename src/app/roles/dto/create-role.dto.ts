import { ImportExcel } from '../../../common/utils/excel-util/dto/excel-util.dto';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

export const CreateRoleInputSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, 'Role name is required')
    .max(100, 'Role name must not exceed 100 characters'),

  description: z
    .string()
    .trim()
    .max(500, 'Description must not exceed 500 characters')
    .nullable()
    .optional(),
});

class CreateRoleDto extends createZodDto(CreateRoleInputSchema) {}

class ImportRolesDto extends ImportExcel {}

export { CreateRoleDto, ImportRolesDto };
