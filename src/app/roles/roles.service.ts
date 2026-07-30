import {
  Injectable,
  NotFoundException,
  BadRequestException,
  Inject,
  ConflictException,
} from '@nestjs/common';
import type { ExtendedPrismaClient } from '../../common/prisma/prisma.service';
import { PRISMA_SERVICE_TOKEN } from '../../common/prisma/prisma.service';
import { PaginationUtilService } from '../../common/utils/pagination-util/pagination-util.service';
import { QueryUtilService } from '../../common/utils/query-util/query-util.service';
import { CreateRoleDto, ImportRolesDto } from './dto/create-role.dto';
import { UpdateRoleDto } from './dto/update-role.dto';
import { ExportRolesDto, GetRolesPaginationDto } from './dto/get-role.dto';
import {
  AUTHORIZATION_ERRORS,
  SYSTEM_ERRORS,
} from '../../common/consts/message';
import { ExcelUtilService } from '../../common/utils/excel-util/excel-util.service';
import { Prisma, Role } from '@prisma/client';
import { RoleEntity } from './entities/role.entity';
import { AuthorizationService } from '../authorization/authorization.service';
import { ReplaceRolePermissionsDto } from './dto/role-permissions.dto';
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
    private authorizationService: AuthorizationService,
  ) {}

  async createRole(createRoleDto: CreateRoleDto) {
    await this.ensureRoleNameAvailable(createRoleDto.name);

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
    const fieldsSelect =
      this.queryUtilService.convertFieldsSelectOption<Role>(select);
    const searchQuery = this.queryUtilService.buildSearchQuery<Role>({
      search,
    });
    const totalItems = await this.prisma.role.count({ where: searchQuery });
    const paging = this.paginationUtilService.paging({
      page,
      itemPerPage,
      totalItems,
    });

    const list = await this.prisma.role.findMany({
      select: fieldsSelect,
      skip: paging.skip,
      take: paging.itemPerPage,
      where: searchQuery,
      orderBy: { createdAt: 'desc' },
    });

    const data = paging.format(list);
    return data;
  }

  async getRoleById(id: string) {
    const role = await this.prisma.role.findUnique({
      where: { id },
    });

    if (!role) {
      throw new NotFoundException(SYSTEM_ERRORS.ROLE_NOT_FOUND);
    }

    return role;
  }

  async updateRole(id: string, updateRoleDto: UpdateRoleDto) {
    const role = await this.getRoleById(id);
    if (role.isSystemRole) {
      throw new BadRequestException(
        AUTHORIZATION_ERRORS.SYSTEM_ROLE_CANNOT_BE_MODIFIED,
      );
    }

    if (updateRoleDto.name) {
      await this.ensureRoleNameAvailable(updateRoleDto.name, id);
    }

    const updated = await this.prisma.role.update({
      where: { id },
      data: updateRoleDto,
    });
    await this.authorizationService.invalidateAll();
    return updated;
  }

  async deleteRole(id: string) {
    const role = await this.getRoleById(id);
    if (role.isSystemRole) {
      throw new BadRequestException(
        SYSTEM_ERRORS.SYSTEM_ROLE_CANNOT_BE_DELETED,
      );
    }
    await this.prisma.$transaction(async (tx) => {
      await tx.rolePermission.deleteMany({ where: { roleId: id } });
      await tx.employeeRole.deleteMany({ where: { roleId: id } });
      await tx.role.delete({ where: { id } });
    });
    await this.authorizationService.invalidateAll();

    return {
      success: true,
      message: `Role #${id} has been deleted successfully`,
    };
  }

  async getRolePermissions(id: string) {
    await this.getRoleById(id);

    return this.prisma.role.findUnique({
      where: { id },
      select: {
        id: true,
        name: true,
        description: true,
        isSystemRole: true,
        rolePermissions: {
          orderBy: { createdAt: 'asc' },
          select: {
            permission: {
              select: {
                id: true,
                name: true,
                key: true,
                description: true,
                isSystemPermission: true,
              },
            },
          },
        },
      },
    });
  }

  async replaceRolePermissions(
    id: string,
    { permissionIds }: ReplaceRolePermissionsDto,
  ) {
    const role = await this.getRoleById(id);
    if (role.isSystemRole) {
      throw new BadRequestException(
        AUTHORIZATION_ERRORS.SYSTEM_ROLE_CANNOT_BE_MODIFIED,
      );
    }

    const uniquePermissionIds = [...new Set(permissionIds)];
    if (uniquePermissionIds.length !== permissionIds.length) {
      throw new BadRequestException(
        AUTHORIZATION_ERRORS.DUPLICATE_PERMISSION_IDS,
      );
    }

    if (uniquePermissionIds.length > 0) {
      const permissions = await this.prisma.permission.findMany({
        where: { id: { in: uniquePermissionIds } },
        select: { id: true },
      });
      if (permissions.length !== uniquePermissionIds.length) {
        throw new BadRequestException(
          AUTHORIZATION_ERRORS.INVALID_PERMISSION_IDS,
        );
      }
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.rolePermission.deleteMany({ where: { roleId: id } });
      if (uniquePermissionIds.length > 0) {
        await tx.rolePermission.createMany({
          data: uniquePermissionIds.map((permissionId) => ({
            roleId: id,
            permissionId,
          })),
          skipDuplicates: true,
        });
      }
    });
    await this.authorizationService.invalidateAll();

    return this.getRolePermissions(id);
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
    await this.authorizationService.invalidateAll();
    return {
      success: true,
      message: `Imported ${result.count} roles successfully.`,
    };
  }

  private async ensureRoleNameAvailable(name: string, excludeId?: string) {
    const existing = await this.prisma.role.findFirst({
      where: {
        name,
        ...(excludeId ? { id: { not: excludeId } } : {}),
      },
      select: { id: true },
    });

    if (existing) {
      throw new ConflictException(AUTHORIZATION_ERRORS.ROLE_NAME_EXISTS);
    }
  }
}
