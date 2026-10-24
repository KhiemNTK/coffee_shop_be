import { createZodDto } from 'nestjs-zod';
import { RoleMetadataInputSchema } from './create-role.dto';

export const UpdateRoleInputSchema = RoleMetadataInputSchema.partial();
export class UpdateRoleDto extends createZodDto(UpdateRoleInputSchema) {}
