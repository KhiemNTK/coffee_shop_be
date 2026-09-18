import { z } from 'zod';
import { createZodDto } from 'nestjs-zod';
import { NewPasswordSchema } from '../../../common/validation/password.schema';
import {
  EmployeeAddressSchema,
  EmployeeEmailSchema,
  EmployeeFullNameSchema,
  EmployeePhoneNumberSchema,
  EmployeeUsernameSchema,
} from '../../../common/validation/employee.schema';

export const CreateEmployeeInputSchema = z.object({
  fullName: EmployeeFullNameSchema,
  email: EmployeeEmailSchema,
  phoneNumber: EmployeePhoneNumberSchema.optional().nullable(),
  address: EmployeeAddressSchema.optional().nullable(),

  avatarUrl: z.url('Avatar must be a valid URL').optional().nullable(),

  username: EmployeeUsernameSchema,

  password: NewPasswordSchema,

  isActive: z.boolean().optional().default(true),

  positionId: z.uuid('Invalid UUID for position'),
});

export class CreateEmployeeDto extends createZodDto(
  CreateEmployeeInputSchema,
) {}
