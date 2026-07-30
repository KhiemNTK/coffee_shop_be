import {
  Controller,
  Get,
  Post,
  Body,
  Patch,
  Param,
  Delete,
  Query,
  Put,
} from '@nestjs/common';
import { EmployeesService } from './employees.service';
import { CreateEmployeeDto } from './dto/create-employee.dto';
import { UpdateEmployeeDto } from './dto/update-employee.dto';
import { IDDto } from '../../common/dto/param.dto';
import { GetEmployeesPaginationDto } from './dto/get-employee.dto';
import { PermissionKeys } from '../../common/consts/permission-keys';
import { RequirePermissions } from '../authorization/authorization.decorator';
import { ReplaceEmployeeRolesDto } from './dto/employee-roles.dto';
@Controller('employees')
export class EmployeesController {
  constructor(private readonly employeesService: EmployeesService) {}

  @Post()
  @RequirePermissions(PermissionKeys.EMPLOYEES_CREATE)
  createEmployee(@Body() createEmployeeDto: CreateEmployeeDto) {
    return this.employeesService.createEmployee(createEmployeeDto);
  }

  @Get()
  @RequirePermissions(PermissionKeys.EMPLOYEES_READ)
  getEmployees(@Query() query: GetEmployeesPaginationDto) {
    return this.employeesService.getEmployees(query);
  }

  @Get(':id/roles')
  @RequirePermissions(PermissionKeys.EMPLOYEE_ROLES_READ)
  getEmployeeRoles(@Param() { id }: IDDto) {
    return this.employeesService.getEmployeeRoles(id);
  }

  @Put(':id/roles')
  @RequirePermissions(PermissionKeys.EMPLOYEE_ROLES_UPDATE)
  replaceEmployeeRoles(
    @Param() { id }: IDDto,
    @Body() replaceEmployeeRolesDto: ReplaceEmployeeRolesDto,
  ) {
    return this.employeesService.replaceEmployeeRoles(
      id,
      replaceEmployeeRolesDto,
    );
  }

  @Get(':id')
  @RequirePermissions(PermissionKeys.EMPLOYEES_READ)
  getEmployeeById(@Param() { id }: IDDto) {
    return this.employeesService.getEmployeeById(id);
  }

  @Patch(':id')
  @RequirePermissions(PermissionKeys.EMPLOYEES_UPDATE)
  updateEmployee(
    @Param() { id }: IDDto,
    @Body() updateEmployeeDto: UpdateEmployeeDto,
  ) {
    return this.employeesService.updateEmployee(id, updateEmployeeDto);
  }

  @Delete(':id')
  @RequirePermissions(PermissionKeys.EMPLOYEES_DELETE)
  deleteEmployee(@Param() { id }: IDDto) {
    return this.employeesService.deleteEmployee(id);
  }
}
