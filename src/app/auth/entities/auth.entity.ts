import { PickType } from '@nestjs/swagger';
import { EmployeeEntity as Employee } from '../../employees/entities/employee.entity';

export class Auth extends PickType(Employee, [
  'email',
  'phoneNumber',
  'password',
]) {}
