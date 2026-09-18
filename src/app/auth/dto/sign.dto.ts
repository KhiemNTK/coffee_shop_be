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
});

const AdditionalSchema = z.object({
  fullName: EmployeeFullNameSchema,
  address: EmployeeAddressSchema.optional().nullable(),
  username: EmployeeUsernameSchema,
  phoneNumber: EmployeePhoneNumberSchema.optional().nullable(),
});

export const SignUpSchema = SignInSchema.extend({
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

export { SignInDto, SignInResponseDto, SignUpDto };
