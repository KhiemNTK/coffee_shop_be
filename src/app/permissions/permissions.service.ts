import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Permission } from '@prisma/client';
import type { ExtendedPrismaClient } from '../../common/prisma/prisma.service';
import { PRISMA_SERVICE_TOKEN } from '../../common/prisma/prisma.service';
import { PaginationUtilService } from '../../common/utils/pagination-util/pagination-util.service';
import { QueryUtilService } from '../../common/utils/query-util/query-util.service';
import { AUTHORIZATION_ERRORS } from '../../common/consts/message';
import { AuthorizationService } from '../authorization/authorization.service';
import { CreatePermissionDto } from './dto/create-permission.dto';
import { GetPermissionsPaginationDto } from './dto/get-permission.dto';
import { UpdatePermissionDto } from './dto/update-permission.dto';

@Injectable()
export class PermissionsService {
  constructor(
    @Inject(PRISMA_SERVICE_TOKEN)
    private readonly prisma: ExtendedPrismaClient,
    private readonly paginationUtilService: PaginationUtilService,
    private readonly queryUtilService: QueryUtilService,
    private readonly authorizationService: AuthorizationService,
  ) {}

  async createPermission(createPermissionDto: CreatePermissionDto) {
    await this.ensurePermissionKeyAvailable(createPermissionDto.key);

    const permission = await this.prisma.permission.create({
      data: createPermissionDto,
    });
    await this.authorizationService.invalidateAll();
    return permission;
  }

  async getPermissions({
    page,
    itemPerPage,
    select,
    ...search
  }: GetPermissionsPaginationDto) {
    const fieldsSelect =
      this.queryUtilService.convertFieldsSelectOption<Permission>(select);
    const searchQuery = this.queryUtilService.buildSearchQuery<Permission>({
      search,
    });
    const totalItems = await this.prisma.permission.count({
      where: searchQuery,
    });
    const paging = this.paginationUtilService.paging({
      page,
      itemPerPage,
      totalItems,
    });

    const list = await this.prisma.permission.findMany({
      select: fieldsSelect,
      skip: paging.skip,
      take: paging.itemPerPage,
      where: searchQuery,
      orderBy: { createdAt: 'desc' },
    });

    return paging.format(list);
  }

  async getPermissionById(id: string) {
    const permission = await this.prisma.permission.findUnique({
      where: { id },
    });

    if (!permission) {
      throw new NotFoundException(AUTHORIZATION_ERRORS.PERMISSION_NOT_FOUND);
    }

    return permission;
  }

  async updatePermission(id: string, updatePermissionDto: UpdatePermissionDto) {
    const permission = await this.getPermissionById(id);

    if (
      permission.isSystemPermission &&
      (updatePermissionDto.name !== undefined ||
        updatePermissionDto.key !== undefined)
    ) {
      throw new BadRequestException(
        AUTHORIZATION_ERRORS.SYSTEM_PERMISSION_CANNOT_BE_MODIFIED,
      );
    }

    if (updatePermissionDto.key) {
      await this.ensurePermissionKeyAvailable(updatePermissionDto.key, id);
    }

    const updated = await this.prisma.permission.update({
      where: { id },
      data: updatePermissionDto,
    });
    await this.authorizationService.invalidateAll();
    return updated;
  }

  async deletePermission(id: string) {
    const permission = await this.getPermissionById(id);
    if (permission.isSystemPermission) {
      throw new BadRequestException(
        AUTHORIZATION_ERRORS.SYSTEM_PERMISSION_CANNOT_BE_DELETED,
      );
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.rolePermission.deleteMany({ where: { permissionId: id } });
      await tx.permission.delete({ where: { id } });
    });
    await this.authorizationService.invalidateAll();

    return {
      success: true,
      message: `Permission #${id} has been deleted successfully`,
    };
  }

  private async ensurePermissionKeyAvailable(key: string, excludeId?: string) {
    const existing = await this.prisma.permission.findFirst({
      where: {
        key,
        ...(excludeId ? { id: { not: excludeId } } : {}),
      },
      select: { id: true },
    });

    if (existing) {
      throw new ConflictException(AUTHORIZATION_ERRORS.PERMISSION_KEY_EXISTS);
    }
  }
}
