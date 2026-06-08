import { EmployeeSchema } from '../../../generated/zod';
import z from 'zod';
import { createZodDto } from 'nestjs-zod';

const ForgotPasswordInputSchema = z
  .object({
    email: EmployeeSchema.shape.email.optional(),
    phoneNumber: EmployeeSchema.shape.phoneNumber.optional(),
    redirectTo: z.url('Redirect URL must be a valid URL'),
  })
  .refine((data) => data.email || data.phoneNumber, {
    message: 'Email or phone number is required',
    path: ['email'],
  });

export class ForgotPasswordDto extends createZodDto(
  ForgotPasswordInputSchema,
) {}

const resetPasswordSchema = z.object({
  token: z.string().min(1, 'Token is required'),
  password: EmployeeSchema.shape.password,
});

export class ResetPasswordDto extends createZodDto(resetPasswordSchema) {}
