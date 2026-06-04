import { Injectable, Inject, NotFoundException } from '@nestjs/common';
import { CreateEmployeeDto } from './dto/create-employee.dto';
import { UpdateEmployeeDto } from './dto/update-employee.dto';
import { Employee, Prisma } from '@prisma/client';
import { PaginationUtilService } from '../../common/utils/pagination-util/pagination-util.service';
import type { ExtendedPrismaClient } from '../../common/prisma/prisma.service';
import { PRISMA_SERVICE_TOKEN } from '../../common/prisma/prisma.service';
import { GetEmployeesPaginationDto } from './dto/get-employee.dto';
import { QueryUtilService } from '../../common/utils/query-util/query-util.service';
@Injectable()
export class EmployeesService {
  constructor(
    @Inject(PRISMA_SERVICE_TOKEN)
    private readonly prisma: ExtendedPrismaClient,
    private paginationUtilService: PaginationUtilService,
    private queryUtilService: QueryUtilService,
  ) {}

  async createEmployee(createEmployeeDto: CreateEmployeeDto) {
    return this.prisma.employee.create({
      data: createEmployeeDto,
    });
  }

  async getEmployee(where: Prisma.EmployeeWhereUniqueInput) {
    const data = await this.prisma.employee.findUnique({
      where,
    });
    return data;
  }

  async getEmployees({
    page,
    itemPerPage,
    select,
    ...search
  }: GetEmployeesPaginationDto) {
    const totalItems = await this.prisma.employee.count();
    const paging = this.paginationUtilService.paging({
      page,
      itemPerPage,
      totalItems,
    });
    const fieldsSelect =
      this.queryUtilService.convertFieldsSelectOption<Employee>(select);
    const searchQuery = this.queryUtilService.buildSearchQuery<Employee>({
      search,
    });
    const list = await this.prisma.employee.findMany({
      select: fieldsSelect,
      skip: paging.skip,
      take: paging.itemPerPage,
      where: searchQuery,
    });

    const data = paging.format(list);
    return data;
  }

  async getEmployeeById(id: string) {
    const employee = await this.prisma.employee.findUnique({
      where: { id },
      include: {
        position: true,
        employeeRoles: {
          include: { role: true },
        },
      },
    });

    if (!employee) {
      throw new NotFoundException(`Employee with ID ${id} not found`);
    }

    return employee;
  }

  async updateEmployee(id: string, updateEmployeeDto: UpdateEmployeeDto) {
    await this.getEmployeeById(id);

    return this.prisma.employee.update({
      where: { id },
      data: updateEmployeeDto,
    });
  }

  async deleteEmployee(id: string) {
    await this.getEmployeeById(id);

    await this.prisma.employee.softDelete({ id });

    return {
      success: true,
      message: `Employee #${id} has been deleted successfully`,
    };
  }
}
