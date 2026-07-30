import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import { InternalServerErrorException } from '@nestjs/common';
import { AUTH_ERRORS } from '../../common/consts/message';
import type { EmployeeInfo } from '../types';

export const Employee = createParamDecorator(
  (data: keyof EmployeeInfo | undefined, ctx: ExecutionContext) => {
    const req = ctx.switchToHttp().getRequest();
    const employee = req.employee;

    if (!employee) {
      throw new InternalServerErrorException(AUTH_ERRORS);
    }

    return data ? employee[data] : (employee as EmployeeInfo);
  },
);
