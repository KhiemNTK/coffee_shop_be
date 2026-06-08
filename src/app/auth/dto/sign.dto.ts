import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { EmployeeSchema } from '../../../generated/zod';
import { withResponse } from '../../../common/interceptors/format-response/format-response.util';
import { TokenKeys } from '../consts/jwt.const';

export const SignInSchema = EmployeeSchema.pick({
  email: true,
  password: true,
});

const AdditionalSchema = EmployeeSchema.pick({
  fullName: true,
  address: true,
  username: true,
  phoneNumber: true,
});

export const SignUpSchema = SignInSchema.extend(AdditionalSchema.shape);

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
