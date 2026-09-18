import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { Prisma, SettingValueType } from '@prisma/client';
import {
  PRISMA_SERVICE_TOKEN,
  type ExtendedPrismaClient,
} from '../../common/prisma/prisma.service';
import type { ExtendedPrismaTransactionClient } from '../../common/types';
import { PaginationUtilService } from '../../common/utils/pagination-util/pagination-util.service';
import {
  CreateSystemSettingDto,
  GetSystemSettingRevisionsDto,
  GetSystemSettingsDto,
  UpdateSystemSettingDto,
} from './dto';

@Injectable()
export class SystemSettingsService {
  constructor(
    @Inject(PRISMA_SERVICE_TOKEN)
    private readonly prisma: ExtendedPrismaClient,
    private readonly paginationUtil: PaginationUtilService,
  ) {}

  async create(employeeId: string, dto: CreateSystemSettingDto) {
    this.assertValueType(dto.valueType, dto.value);

    try {
      return await this.prisma.$transaction(async (tx) => {
        await this.assertActiveEmployee(tx, employeeId);
        const setting = await tx.systemSetting.create({
          data: {
            key: dto.key,
            value: this.toJsonInput(dto.value),
            valueType: dto.valueType,
            description: dto.description,
            isPublic: dto.isPublic,
            updatedById: employeeId,
          },
          include: this.settingInclude,
        });
        await this.createRevision(tx, setting, employeeId);
        await this.logAction(tx, employeeId, 'SYSTEM_SETTING_CREATED', {
          settingId: setting.id,
          key: setting.key,
          version: setting.version,
        });
        return setting;
      });
    } catch (error) {
      this.rethrowKeyConflict(error);
    }
  }

  async findAll(query: GetSystemSettingsDto) {
    const where: Prisma.SystemSettingWhereInput = {
      deletedAt: null,
      ...(query.valueType ? { valueType: query.valueType } : {}),
      ...(query.keyword
        ? {
            OR: [
              {
                key: {
                  contains: query.keyword,
                  mode: Prisma.QueryMode.insensitive,
                },
              },
              {
                description: {
                  contains: query.keyword,
                  mode: Prisma.QueryMode.insensitive,
                },
              },
            ],
          }
        : {}),
    };
    const totalItems = await this.prisma.systemSetting.count({ where });
    const paging = this.paginationUtil.paging({ ...query, totalItems });
    const settings = await this.prisma.systemSetting.findMany({
      where,
      skip: paging.skip,
      take: paging.itemPerPage,
      orderBy: [{ key: 'asc' }, { id: 'asc' }],
      include: this.settingInclude,
    });
    return paging.format(settings);
  }

  async findOne(key: string) {
    const setting = await this.prisma.systemSetting.findFirst({
      where: { key, deletedAt: null },
      include: this.settingInclude,
    });
    if (!setting) {
      throw new NotFoundException(`System setting '${key}' not found.`);
    }
    return setting;
  }

  async findRevisions(key: string, query: GetSystemSettingRevisionsDto) {
    const setting = await this.prisma.systemSetting.findFirst({
      where: { key, deletedAt: null },
      select: { id: true },
    });
    if (!setting) {
      throw new NotFoundException(`System setting '${key}' not found.`);
    }

    const where = { settingId: setting.id };
    const totalItems = await this.prisma.systemSettingRevision.count({ where });
    const paging = this.paginationUtil.paging({ ...query, totalItems });
    const revisions = await this.prisma.systemSettingRevision.findMany({
      where,
      skip: paging.skip,
      take: paging.itemPerPage,
      orderBy: [{ version: 'desc' }, { id: 'desc' }],
      include: {
        employee: { select: { id: true, fullName: true } },
      },
    });
    return paging.format(revisions);
  }

  async update(
    key: string,
    employeeId: string,
    { expectedVersion, ...dto }: UpdateSystemSettingDto,
  ) {
    return this.prisma.$transaction(async (tx) => {
      await this.assertActiveEmployee(tx, employeeId);
      const existing = await tx.systemSetting.findFirst({
        where: { key, deletedAt: null },
      });
      if (!existing) {
        throw new NotFoundException(`System setting '${key}' not found.`);
      }
      if (dto.value !== undefined) {
        this.assertValueType(existing.valueType, dto.value);
      }

      const updated = await tx.systemSetting.updateMany({
        where: { id: existing.id, version: expectedVersion, deletedAt: null },
        data: {
          value:
            dto.value === undefined ? undefined : this.toJsonInput(dto.value),
          description: dto.description,
          isPublic: dto.isPublic,
          updatedById: employeeId,
          version: { increment: 1 },
        },
      });
      if (updated.count !== 1) {
        throw new ConflictException(
          'System setting was modified by another request.',
        );
      }

      const setting = await tx.systemSetting.findUniqueOrThrow({
        where: { id: existing.id },
        include: this.settingInclude,
      });
      await this.createRevision(tx, setting, employeeId);
      await this.logAction(tx, employeeId, 'SYSTEM_SETTING_UPDATED', {
        settingId: setting.id,
        key: setting.key,
        previousVersion: expectedVersion,
        version: setting.version,
      });
      return setting;
    });
  }

  async remove(key: string, employeeId: string, expectedVersion: number) {
    return this.prisma.$transaction(async (tx) => {
      await this.assertActiveEmployee(tx, employeeId);
      const existing = await tx.systemSetting.findFirst({
        where: { key, deletedAt: null },
      });
      if (!existing) {
        throw new NotFoundException(`System setting '${key}' not found.`);
      }
      if (existing.isSystem) {
        throw new ForbiddenException('System settings cannot be deleted.');
      }

      const deletedAt = new Date();
      const deleted = await tx.systemSetting.updateMany({
        where: { id: existing.id, version: expectedVersion, deletedAt: null },
        data: {
          deletedAt,
          updatedById: employeeId,
          version: { increment: 1 },
        },
      });
      if (deleted.count !== 1) {
        throw new ConflictException(
          'System setting was modified by another request.',
        );
      }

      const setting = {
        ...existing,
        version: expectedVersion + 1,
        deletedAt,
      };
      await this.createRevision(tx, setting, employeeId);
      await this.logAction(tx, employeeId, 'SYSTEM_SETTING_DELETED', {
        settingId: setting.id,
        key: setting.key,
        previousVersion: expectedVersion,
        version: setting.version,
      });
      return { success: true, key, version: setting.version };
    });
  }

  private readonly settingInclude = {
    updatedBy: { select: { id: true, fullName: true } },
  } as const;

  private assertValueType(valueType: SettingValueType, value: unknown) {
    const isValid =
      (valueType === SettingValueType.STRING && typeof value === 'string') ||
      (valueType === SettingValueType.NUMBER &&
        typeof value === 'number' &&
        Number.isFinite(value)) ||
      (valueType === SettingValueType.BOOLEAN && typeof value === 'boolean') ||
      (valueType === SettingValueType.JSON &&
        (value === null || typeof value === 'object'));

    if (!isValid) {
      throw new BadRequestException(`Value does not match ${valueType}.`);
    }
  }

  private toJsonInput(value: unknown) {
    return value === null ? Prisma.JsonNull : (value as Prisma.InputJsonValue);
  }

  private async createRevision(
    tx: ExtendedPrismaTransactionClient,
    setting: {
      id: string;
      version: number;
      value: unknown;
      valueType: SettingValueType;
      description: string | null;
      isPublic: boolean;
      deletedAt: Date | null;
    },
    employeeId: string,
  ) {
    await tx.systemSettingRevision.create({
      data: {
        settingId: setting.id,
        employeeId,
        version: setting.version,
        value: this.toJsonInput(setting.value),
        valueType: setting.valueType,
        description: setting.description,
        isPublic: setting.isPublic,
        deletedAt: setting.deletedAt,
      },
    });
  }

  private async assertActiveEmployee(
    tx: ExtendedPrismaTransactionClient,
    employeeId: string,
  ) {
    const employee = await tx.employee.findFirst({
      where: { id: employeeId, isActive: true, deletedAt: null },
      select: { id: true },
    });
    if (!employee) {
      throw new UnauthorizedException('Employee is inactive or not found.');
    }
  }

  private async logAction(
    tx: ExtendedPrismaTransactionClient,
    employeeId: string,
    actionType: string,
    details: Prisma.InputJsonObject,
  ) {
    await tx.actionLog.create({
      data: { employeeId, actionType, details },
    });
  }

  private rethrowKeyConflict(error: unknown): never {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === 'P2002'
    ) {
      throw new ConflictException('System setting key already exists.');
    }
    throw error;
  }
}
