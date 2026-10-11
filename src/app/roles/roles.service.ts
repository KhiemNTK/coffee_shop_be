import {
  Injectable,
  NotFoundException,
  BadRequestException,
  Inject,
  ConflictException,
  ForbiddenException,
} from '@nestjs/common';
import {
  type ExtendedPrismaClient,
  PRISMA_SERVICE_TOKEN,
} from '../../common/prisma/prisma.service';
import { PaginationUtilService } from '../../common/utils/pagination-util/pagination-util.service';
import { QueryUtilService } from '../../common/utils/query-util/query-util.service';
import {
  CreateRoleDto,
  ExportRolesDto,
  GetRolesPaginationDto,
  ImportRolesDto,
  ReplaceRolePermissionsDto,
  UpdateRoleDto,
} from './dto';
import {
  AUTHORIZATION_ERRORS,
  SYSTEM_ERRORS,
} from '../../common/consts/message';
import { ExcelUtilService } from '../../common/utils/excel-util/excel-util.service';
import { Prisma, Role } from '@prisma/client';
import { RoleEntity } from './entities/role.entity';
import { AuthorizationService } from '../authorization/authorization.service';
import { PermissionKeys } from '../../common/consts/permission-keys';
import type { ExtendedPrismaTransactionClient } from '../../common/types';
import { runSerializableTransaction } from '../../common/prisma/transaction.util';
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

  async deleteRole(id: string, actorId: string) {
    await runSerializableTransaction(this.prisma, async (tx) => {
      const { role } = await this.loadManagedRole(
        tx,
        id,
        actorId,
        PermissionKeys.ROLES_DELETE,
      );
      if (role.isSystemRole)
        throw new BadRequestException(
          SYSTEM_ERRORS.SYSTEM_ROLE_CANNOT_BE_DELETED,
        );
      await tx.rolePermission.deleteMany({ where: { roleId: id } });
      await tx.employeeRole.deleteMany({ where: { roleId: id } });
      await tx.role.update({
        where: { id, deletedAt: null },
        data: { deletedAt: new Date() },
      });
      await tx.actionLog.create({
        data: {
          employeeId: actorId,
          actionType: 'ROLE_DELETED',
          details: {
            roleId: id,
            beforePermissionIds: role.rolePermissions.map(
              (item) => item.permission.id,
            ),
          },
        },
      });
    });
    await this.authorizationService.invalidateAll();

    return {
      success: true,
      message: `Role #${id} has been deleted successfully`,
    };
  }

  async getRolePermissions(id: string, actorId: string) {
    const role = await this.prisma.role.findUnique({
      where: { id },
      select: {
        id: true,
        name: true,
        description: true,
        isSystemRole: true,
        rolePermissions: {
          where: { permission: { deletedAt: null } },
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
    if (!role) throw new NotFoundException(SYSTEM_ERRORS.ROLE_NOT_FOUND);
    const actor =
      await this.authorizationService.getFreshAuthorizationContext(actorId);
    const ownAssignment = await this.prisma.employeeRole.findUnique({
      where: { employeeId_roleId: { employeeId: actorId, roleId: id } },
      select: { roleId: true },
    });
    return {
      ...role,
      canManagePermissions:
        !role.isSystemRole &&
        !ownAssignment &&
        this.authorizationService.canGrantPermissions(actor, [
          PermissionKeys.ROLE_PERMISSIONS_UPDATE,
          ...role.rolePermissions.map((entry) => entry.permission.key),
        ]),
    };
  }

  async replaceRolePermissions(
    id: string,
    { permissionIds }: ReplaceRolePermissionsDto,
    actorId: string,
  ) {
    const uniquePermissionIds = [...new Set(permissionIds)];
    if (uniquePermissionIds.length !== permissionIds.length) {
      throw new BadRequestException(
        AUTHORIZATION_ERRORS.DUPLICATE_PERMISSION_IDS,
      );
    }

    await runSerializableTransaction(this.prisma, async (tx) => {
      const { role, actor } = await this.loadManagedRole(
        tx,
        id,
        actorId,
        PermissionKeys.ROLE_PERMISSIONS_UPDATE,
      );
      if (role.isSystemRole)
        throw new BadRequestException(
          AUTHORIZATION_ERRORS.SYSTEM_ROLE_CANNOT_BE_MODIFIED,
        );
      const permissions = await tx.permission.findMany({
        where: { id: { in: uniquePermissionIds }, deletedAt: null },
        select: { id: true, key: true },
      });
      if (permissions.length !== uniquePermissionIds.length) {
        throw new BadRequestException(
          AUTHORIZATION_ERRORS.INVALID_PERMISSION_IDS,
        );
      }
      this.authorizationService.assertCanGrantPermissions(
        actor,
        permissions.map((permission) => permission.key),
      );
      const beforeIds = role.rolePermissions
        .map((item) => item.permission.id)
        .sort();
      if (
        beforeIds.length === uniquePermissionIds.length &&
        beforeIds.every((permissionId) =>
          uniquePermissionIds.includes(permissionId),
        )
      )
        return;
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
      await tx.actionLog.create({
        data: {
          employeeId: actorId,
          actionType: 'ROLE_PERMISSIONS_REPLACED',
          details: {
            roleId: id,
            beforePermissionIds: beforeIds,
            afterPermissionIds: [...uniquePermissionIds].sort(),
          },
        },
      });
    });
    await this.authorizationService.invalidateAll();

    return this.getRolePermissions(id, actorId);
  }

  private async loadManagedRole(
    tx: ExtendedPrismaTransactionClient,
    id: string,
    actorId: string,
    requiredPermission: string,
  ) {
    const actor = await this.authorizationService.getFreshAuthorizationContext(
      actorId,
      tx,
    );
    this.authorizationService.assertCanGrantPermissions(actor, [
      requiredPermission,
    ]);
    const role = await tx.role.findUnique({
      where: { id, deletedAt: null },
      select: {
        id: true,
        isSystemRole: true,
        rolePermissions: {
          where: { permission: { deletedAt: null } },
          select: { permission: { select: { id: true, key: true } } },
        },
      },
    });
    if (!role) throw new NotFoundException(SYSTEM_ERRORS.ROLE_NOT_FOUND);
    this.authorizationService.assertCanGrantPermissions(
      actor,
      role.rolePermissions.map((item) => item.permission.key),
    );
    const ownAssignment = await tx.employeeRole.findUnique({
      where: { employeeId_roleId: { employeeId: actorId, roleId: id } },
      select: { roleId: true },
    });
    if (ownAssignment)
      throw new ForbiddenException(AUTHORIZATION_ERRORS.SELF_ACCESS_CHANGE);
    return { role, actor };
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
