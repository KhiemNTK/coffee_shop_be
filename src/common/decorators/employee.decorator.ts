import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import { EmployeeEntity } from '../../app/employees/entities/employee.entity';

export interface EmployeeInfo {
  employeeId: EmployeeEntity['id'];
  email: EmployeeEntity['email'];
}

export const Employee = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext) => {
    const req = ctx.switchToHttp().getRequest();
    return req.employee as EmployeeInfo;
  },
);

export type WithEmployee<T> = T & { employee: EmployeeInfo };
