import {
  Injectable,
  NotFoundException,
  BadRequestException,
  Inject,
} from '@nestjs/common';
import type { ExtendedPrismaClient } from '../../common/prisma/prisma.service';
import { PRISMA_SERVICE_TOKEN } from '../../common/prisma/prisma.service';
import { PaginationUtilService } from '../../common/utils/pagination-util/pagination-util.service';
import { QueryUtilService } from '../../common/utils/query-util/query-util.service';
import { CreateRoleDto, ImportRolesDto } from './dto/create-role.dto';
import { UpdateRoleDto } from './dto/update-role.dto';
import { ExportRolesDto, GetRolesPaginationDto } from './dto/get-role.dto';
import {
  ROLE_NOT_FOUND,
  SYSTEM_ROLE_CANNOT_BE_DELETED,
} from '../../common/consts/message';
import { ExcelUtilService } from '../../common/utils/excel-util/excel-util.service';
import { Role } from '@prisma/client';
import { RoleEntity } from './entities/role.entity';
import { Prisma } from '@prisma/client';
@Injectable()
export class RolesService {
  private roleEntityName = RoleEntity.name;
  private excelSheets = {
    [this.roleEntityName]: this.roleEntityName,
  };
  constructor(
    @Inject(PRISMA_SERVICE_TOKEN)
    private readonly prisma: ExtendedPrismaClient,
    private paginationUtilService: PaginationUtilService,
    private queryUtilService: QueryUtilService,
    private excelUtilService: ExcelUtilService,
  ) {}

  async createRole(createRoleDto: CreateRoleDto) {
    return this.prisma.role.create({
      data: createRoleDto,
    });
  }

  async getRoles({
    page,
    itemPerPage,
    select,
    ...search
  }: GetRolesPaginationDto) {
    const totalItems = await this.prisma.role.count();
    const paging = this.paginationUtilService.paging({
      page,
      itemPerPage,
      totalItems,
    });
    const fieldsSelect =
      this.queryUtilService.convertFieldsSelectOption<Role>(select);
    const searchQuery = this.queryUtilService.buildSearchQuery<Role>({
      search,
    });

    const list = await this.prisma.role.findMany({
      select: fieldsSelect,
      skip: paging.skip,
      take: paging.itemPerPage,
      where: searchQuery,
    });

    const data = paging.format(list);
    return data;
  }

  async getRoleById(id: string) {
    const role = await this.prisma.role.findUnique({
      where: { id },
    });

    if (!role) {
      throw new NotFoundException(ROLE_NOT_FOUND);
    }

    return role;
  }

  async updateRole(id: string, updateRoleDto: UpdateRoleDto) {
    await this.getRoleById(id);

    return this.prisma.role.update({
      where: { id },
      data: updateRoleDto,
    });
  }

  async deleteRole(id: string) {
    const role = await this.getRoleById(id);
    if (role.isSystemRole) {
      throw new BadRequestException(SYSTEM_ROLE_CANNOT_BE_DELETED);
    }
    await this.prisma.role.softDelete({ id });

    return {
      success: true,
      message: `Role #${id} has been deleted successfully`,
    };
  }

  async exportRoles({ ids, select }: ExportRolesDto) {
    const where: Record<string, any> = {};
    if (ids) {
      where.id = { in: ids };
    }
    const fieldsSelect =
      this.queryUtilService.convertFieldsSelectOption<Role>(select);
    const roles = await this.prisma.role.export({
      select: fieldsSelect,
      where,
    });
    const data = this.excelUtilService.generateExcel({
      worksheets: [
        {
          sheetName: this.excelSheets[this.roleEntityName],
          data: roles,
        },
      ],
    });
    return data;
  }

  async importRoles({ file }: ImportRolesDto) {
    const roleSheetName = this.excelSheets[this.roleEntityName];
    const dataCreated = await this.excelUtilService.read(file);
    const roleData = dataCreated[roleSheetName];
    if (!roleData || !Array.isArray(roleData) || roleData.length === 0) {
      throw new BadRequestException(
        `Sheet '${roleSheetName}' is empty or not found in the uploaded Excel file.`,
      );
    }
    const insertData = roleData.map((item: any): Prisma.RoleCreateManyInput => {
      return {
        ...(item as Prisma.RoleCreateManyInput),
      };
    });
    const result = await this.prisma.role.createMany({
      data: insertData,
      skipDuplicates: true,
    });
    return {
      success: true,
      message: `Imported ${result.count} roles successfully.`,
    };
  }
}
