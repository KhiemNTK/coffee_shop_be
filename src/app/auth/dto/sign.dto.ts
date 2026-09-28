import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { withResponse } from '../../../common/interceptors/format-response/format-response.util';
import { TokenKeys } from '../consts/jwt.const';
import {
  ExistingPasswordSchema,
  NewPasswordSchema,
} from '../../../common/validation/password.schema';
import {
  EmployeeAddressSchema,
  EmployeeEmailSchema,
  EmployeeFullNameSchema,
  EmployeePhoneNumberSchema,
  EmployeeUsernameSchema,
} from '../../../common/validation/employee.schema';

export const SignInSchema = z.object({
  email: EmployeeEmailSchema,
  password: ExistingPasswordSchema,
  turnstileToken: z.string().min(1).max(2048).optional(),
});

const AdditionalSchema = z.object({
  fullName: EmployeeFullNameSchema,
  address: EmployeeAddressSchema.optional().nullable(),
  username: EmployeeUsernameSchema,
  phoneNumber: EmployeePhoneNumberSchema.optional().nullable(),
});

export const SignUpSchema = SignInSchema.omit({ turnstileToken: true }).extend({
  ...AdditionalSchema.shape,
  password: NewPasswordSchema,
});

const SignInResponseSchema = withResponse(
  z.object({
    [TokenKeys.ACCESS_TOKEN_KEY]: z.string(),
    [TokenKeys.REFRESH_TOKEN_KEY]: z.string(),
  }),
);

class SignInDto extends createZodDto(SignInSchema) {}

class SignInResponseDto extends createZodDto(SignInResponseSchema) {}

class SignUpDto extends createZodDto(SignUpSchema) {}

class GoogleSignInDto extends createZodDto(
  z.object({
    idToken: z.string().min(100).max(8192),
    turnstileToken: z.string().min(1).max(2048).optional(),
  }),
) {}

class GoogleLinkDto extends createZodDto(
  z.object({
    idToken: z.string().min(100).max(8192),
    password: ExistingPasswordSchema,
  }),
) {}

class GoogleUnlinkDto extends createZodDto(
  z.object({ password: ExistingPasswordSchema }),
) {}

export {
  SignInDto,
  SignInResponseDto,
  SignUpDto,
  GoogleSignInDto,
  GoogleLinkDto,
  GoogleUnlinkDto,
};
