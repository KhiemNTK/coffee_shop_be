import { createZodDto } from 'nestjs-zod';
import { CreateRoleInputSchema } from './create-role.dto';

export const UpdateRoleInputSchema = CreateRoleInputSchema.partial();
export class UpdateRoleDto extends createZodDto(UpdateRoleInputSchema) {}
