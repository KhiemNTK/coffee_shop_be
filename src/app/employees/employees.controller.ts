import {
  Controller,
  Get,
  Post,
  Body,
  Patch,
  Param,
  Delete,
  Query,
} from '@nestjs/common';
import { EmployeesService } from './employees.service';
import { CreateEmployeeDto } from './dto/create-employee.dto';
import { UpdateEmployeeDto } from './dto/update-employee.dto';
import { IDDto } from '../../common/dto/param.dto';
import { GetEmployeesPaginationDto } from './dto/get-employee.dto';
import { Employee } from 'src/common/decorators/employee.decorator';
@Controller('employees')
export class EmployeesController {
  constructor(private readonly employeesService: EmployeesService) {}

  @Post()
  createEmployee(@Body() createEmployeeDto: CreateEmployeeDto) {
    return this.employeesService.createEmployee(createEmployeeDto);
  }

  @Get()
  getEmployees(@Query() query: GetEmployeesPaginationDto) {
    return this.employeesService.getEmployees(query);
  }

  @Get(':id')
  getEmployeeById(@Param() { id }: IDDto) {
    return this.employeesService.getEmployeeById(id);
  }

  @Patch(':id')
  updateEmployee(
    @Param() { id }: IDDto,
    @Body() updateEmployeeDto: UpdateEmployeeDto,
  ) {
    return this.employeesService.updateEmployee(id, updateEmployeeDto);
  }

  @Delete(':id')
  deleteEmployee(@Param() { id }: IDDto) {
    return this.employeesService.deleteEmployee(id);
  }
}
