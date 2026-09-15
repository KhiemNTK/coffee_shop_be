import { EmployeeSchema } from '../../../generated/zod';
import z from 'zod';
import { createZodDto } from 'nestjs-zod';
import { NewPasswordSchema } from '../../../common/validation/password.schema';

const ForgotPasswordInputSchema = z
  .object({
    email: EmployeeSchema.shape.email.optional(),
    phoneNumber: EmployeeSchema.shape.phoneNumber.optional(),
  })
  .refine((data) => data.email || data.phoneNumber, {
    message: 'Email or phone number is required',
    path: ['email'],
  });

export class ForgotPasswordDto extends createZodDto(
  ForgotPasswordInputSchema,
) {}

const resetPasswordSchema = z.object({
  token: z.string().min(32, 'Invalid token').max(128, 'Invalid token'),
  password: NewPasswordSchema,
});

export class ResetPasswordDto extends createZodDto(resetPasswordSchema) {}
