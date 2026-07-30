import {
  BadRequestException,
  Injectable,
  Inject,
  NotFoundException,
} from '@nestjs/common';
import { CreateEmployeeDto } from './dto/create-employee.dto';
import { UpdateEmployeeDto } from './dto/update-employee.dto';
import { Employee, Prisma } from '@prisma/client';
import { PaginationUtilService } from '../../common/utils/pagination-util/pagination-util.service';
import type { ExtendedPrismaClient } from '../../common/prisma/prisma.service';
import { PRISMA_SERVICE_TOKEN } from '../../common/prisma/prisma.service';
import { GetEmployeesPaginationDto } from './dto/get-employee.dto';
import { QueryUtilService } from '../../common/utils/query-util/query-util.service';
import { AUTH_ERRORS, AUTHORIZATION_ERRORS } from '../../common/consts/message';
import { AuthorizationService } from '../authorization/authorization.service';
import { ReplaceEmployeeRolesDto } from './dto/employee-roles.dto';
@Injectable()
export class EmployeesService {
  constructor(
    @Inject(PRISMA_SERVICE_TOKEN)
    private readonly prisma: ExtendedPrismaClient,
    private paginationUtilService: PaginationUtilService,
    private queryUtilService: QueryUtilService,
    private authorizationService: AuthorizationService,
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

  private async findEmployeeOrThrow(id: string): Promise<Employee> {
    const employee = await this.prisma.employee.findUnique({ where: { id } });
    if (!employee) throw new NotFoundException(AUTH_ERRORS.USER_NOT_FOUND);
    return employee;
  }

  async getEmployees({
    page,
    itemPerPage,
    select,
    ...search
  }: GetEmployeesPaginationDto) {
    const fieldsSelect =
      this.queryUtilService.convertFieldsSelectOption<Employee>(select);
    const searchQuery = this.queryUtilService.buildSearchQuery<Employee>({
      search,
    });
    const totalItems = await this.prisma.employee.count({
      where: searchQuery,
    });
    const paging = this.paginationUtilService.paging({
      page,
      itemPerPage,
      totalItems,
    });
    const list = await this.prisma.employee.findMany({
      select: fieldsSelect,
      skip: paging.skip,
      take: paging.itemPerPage,
      where: searchQuery,
      orderBy: { createdAt: 'desc' },
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
      throw new NotFoundException(AUTH_ERRORS.USER_NOT_FOUND);
    }

    return employee;
  }

  async updateEmployee(id: string, updateEmployeeDto: UpdateEmployeeDto) {
    await this.findEmployeeOrThrow(id);

    const employee = await this.prisma.employee.update({
      where: { id },
      data: updateEmployeeDto,
    });
    await this.authorizationService.invalidateEmployee(id);
    return employee;
  }

  async deleteEmployee(id: string) {
    await this.findEmployeeOrThrow(id);

    await this.prisma.$transaction(async (tx) => {
      await tx.employeeRole.deleteMany({ where: { employeeId: id } });
      await tx.employee.delete({ where: { id } });
    });
    await this.authorizationService.invalidateEmployee(id);

    return {
      success: true,
      message: `Employee #${id} has been deleted successfully`,
    };
  }

  async getEmployeeRoles(id: string) {
    await this.findEmployeeOrThrow(id);

    return this.prisma.employee.findUnique({
      where: { id },
      select: {
        id: true,
        email: true,
        fullName: true,
        isActive: true,
        employeeRoles: {
          orderBy: { createdAt: 'asc' },
          select: {
            role: {
              select: {
                id: true,
                name: true,
                description: true,
                isSystemRole: true,
              },
            },
          },
        },
      },
    });
  }

  async replaceEmployeeRoles(id: string, { roleIds }: ReplaceEmployeeRolesDto) {
    const employee = await this.findEmployeeOrThrow(id);
    if (!employee.isActive) {
      throw new BadRequestException(AUTH_ERRORS.INACTIVE_EMPLOYEE);
    }

    const uniqueRoleIds = [...new Set(roleIds)];
    if (uniqueRoleIds.length !== roleIds.length) {
      throw new BadRequestException(AUTHORIZATION_ERRORS.DUPLICATE_ROLE_IDS);
    }

    if (uniqueRoleIds.length > 0) {
      const roles = await this.prisma.role.findMany({
        where: { id: { in: uniqueRoleIds } },
        select: { id: true },
      });
      if (roles.length !== uniqueRoleIds.length) {
        throw new BadRequestException(AUTHORIZATION_ERRORS.INVALID_ROLE_IDS);
      }
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.employeeRole.deleteMany({ where: { employeeId: id } });
      if (uniqueRoleIds.length > 0) {
        await tx.employeeRole.createMany({
          data: uniqueRoleIds.map((roleId) => ({ employeeId: id, roleId })),
          skipDuplicates: true,
        });
      }
    });
    await this.authorizationService.invalidateEmployee(id);

    return this.getEmployeeRoles(id);
  }
}
