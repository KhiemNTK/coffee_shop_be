import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import { EmployeeEntity } from '../../app/employees/entities/employee.entity';
import { InternalServerErrorException } from '@nestjs/common';
import { USER_NOT_FOUND } from '../../common/consts/message';
export interface EmployeeInfo {
  employeeId: EmployeeEntity['id'];
  email: EmployeeEntity['email'];
}

export const Employee = createParamDecorator(
  (data: keyof EmployeeInfo | undefined, ctx: ExecutionContext) => {
    const req = ctx.switchToHttp().getRequest();
    const employee = req.employee;

    if (!employee) {
      throw new InternalServerErrorException(USER_NOT_FOUND);
    }

    return data ? employee[data] : (employee as EmployeeInfo);
  },
);
