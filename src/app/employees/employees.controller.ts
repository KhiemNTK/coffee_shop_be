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
import { IDDto } from '../../common/dto/param.dto';
import { PermissionKeys } from '../../common/consts/permission-keys';
import { RequirePermissions } from '../authorization/authorization.decorator';
import { Employee } from '../../common/decorators/employee.decorator';
import {
  CreateEmployeeDto,
  GetEmployeesPaginationDto,
  ReplaceEmployeeRolesDto,
  UpdateEmployeeDto,
} from './dto';
import { ApiTags } from '@nestjs/swagger';

@ApiTags('Employees')
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
  getEmployeeRoles(
    @Param() { id }: IDDto,
    @Employee('employeeId') actorId: string,
  ) {
    return this.employeesService.getEmployeeRoles(id, actorId);
  }

  @Put(':id/roles')
  @RequirePermissions(PermissionKeys.EMPLOYEE_ROLES_UPDATE)
  replaceEmployeeRoles(
    @Param() { id }: IDDto,
    @Body() replaceEmployeeRolesDto: ReplaceEmployeeRolesDto,
    @Employee('employeeId') actorId: string,
  ) {
    return this.employeesService.replaceEmployeeRoles(
      id,
      replaceEmployeeRolesDto,
      actorId,
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
    @Employee('employeeId') actorId: string,
  ) {
    return this.employeesService.updateEmployee(id, updateEmployeeDto, actorId);
  }

  @Delete(':id')
  @RequirePermissions(PermissionKeys.EMPLOYEES_DELETE)
  deleteEmployee(
    @Param() { id }: IDDto,
    @Employee('employeeId') actorId: string,
  ) {
    return this.employeesService.deleteEmployee(id, actorId);
  }
}
