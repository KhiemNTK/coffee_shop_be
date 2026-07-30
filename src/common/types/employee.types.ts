import type { EmployeeEntity } from '../../app/employees/entities/employee.entity';
import type { PermissionKey } from './authorization.types';

export interface EmployeeInfo {
  employeeId: EmployeeEntity['id'];
  employeeEmail?: EmployeeEntity['email'];
  email?: EmployeeEntity['email'];
  permissionKeys?: PermissionKey[];
  roleNames?: string[];
}
