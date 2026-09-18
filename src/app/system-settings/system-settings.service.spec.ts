import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
} from '@nestjs/common';
import { SettingValueType } from '@prisma/client';
import type { ExtendedPrismaClient } from '../../common/prisma/prisma.service';
import { PaginationUtilService } from '../../common/utils/pagination-util/pagination-util.service';
import { SystemSettingsService } from './system-settings.service';

describe('SystemSettingsService', () => {
  const setting = {
    id: 'setting-id',
    key: 'store.timezone',
    value: 'Asia/Ho_Chi_Minh',
    valueType: SettingValueType.STRING,
    description: null,
    isPublic: false,
    isSystem: false,
    version: 1,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    deletedAt: null,
    updatedById: 'employee-id',
  };
  const tx = {
    employee: { findFirst: jest.fn() },
    systemSetting: {
      create: jest.fn(),
      findFirst: jest.fn(),
      findUniqueOrThrow: jest.fn(),
      updateMany: jest.fn(),
    },
    systemSettingRevision: { create: jest.fn() },
    actionLog: { create: jest.fn() },
  };
  const prisma = {
    $transaction: jest.fn(),
    systemSetting: {
      count: jest.fn(),
      findMany: jest.fn(),
      findFirst: jest.fn(),
    },
    systemSettingRevision: { count: jest.fn(), findMany: jest.fn() },
  };
  let service: SystemSettingsService;

  beforeEach(() => {
    jest.clearAllMocks();
    prisma.$transaction.mockImplementation(
      async (callback: (client: typeof tx) => Promise<unknown>) => callback(tx),
    );
    tx.employee.findFirst.mockResolvedValue({ id: 'employee-id' });
    tx.systemSetting.create.mockResolvedValue(setting);
    tx.systemSettingRevision.create.mockResolvedValue({ id: 'revision-id' });
    tx.actionLog.create.mockResolvedValue({ id: 'log-id' });

    service = new SystemSettingsService(
      prisma as unknown as ExtendedPrismaClient,
      new PaginationUtilService(),
    );
  });

  it('creates the initial revision without copying the value into the action log', async () => {
    await expect(
      service.create('employee-id', {
        key: setting.key,
        value: setting.value,
        valueType: SettingValueType.STRING,
        isPublic: false,
      }),
    ).resolves.toBe(setting);

    expect(tx.systemSettingRevision.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        settingId: setting.id,
        version: 1,
        value: setting.value,
      }),
    });
    expect(tx.actionLog.create).toHaveBeenCalledWith({
      data: {
        employeeId: 'employee-id',
        actionType: 'SYSTEM_SETTING_CREATED',
        details: {
          settingId: setting.id,
          key: setting.key,
          version: 1,
        },
      },
    });
  });

  it('rejects a value that does not match its declared type', async () => {
    await expect(
      service.create('employee-id', {
        key: setting.key,
        value: 'not-a-number',
        valueType: SettingValueType.NUMBER,
        isPublic: false,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('rejects an update when the expected version is stale', async () => {
    tx.systemSetting.findFirst.mockResolvedValue(setting);
    tx.systemSetting.updateMany.mockResolvedValue({ count: 0 });

    await expect(
      service.update(setting.key, 'employee-id', {
        expectedVersion: 1,
        value: 'UTC',
      }),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(tx.systemSettingRevision.create).not.toHaveBeenCalled();
  });

  it('increments the version and records a revision atomically', async () => {
    const updated = { ...setting, value: 'UTC', version: 2 };
    tx.systemSetting.findFirst.mockResolvedValue(setting);
    tx.systemSetting.updateMany.mockResolvedValue({ count: 1 });
    tx.systemSetting.findUniqueOrThrow.mockResolvedValue(updated);

    await expect(
      service.update(setting.key, 'employee-id', {
        expectedVersion: 1,
        value: 'UTC',
      }),
    ).resolves.toBe(updated);

    expect(tx.systemSetting.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ version: 1 }),
        data: expect.objectContaining({ version: { increment: 1 } }),
      }),
    );
    expect(tx.systemSettingRevision.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ version: 2, value: 'UTC' }),
    });
  });

  it('does not delete protected system settings', async () => {
    tx.systemSetting.findFirst.mockResolvedValue({
      ...setting,
      isSystem: true,
    });

    await expect(
      service.remove(setting.key, 'employee-id', 1),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(tx.systemSetting.updateMany).not.toHaveBeenCalled();
  });

  it('soft-deletes with a final immutable revision', async () => {
    tx.systemSetting.findFirst.mockResolvedValue(setting);
    tx.systemSetting.updateMany.mockResolvedValue({ count: 1 });

    await expect(
      service.remove(setting.key, 'employee-id', 1),
    ).resolves.toEqual({ success: true, key: setting.key, version: 2 });

    expect(tx.systemSettingRevision.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        settingId: setting.id,
        version: 2,
        deletedAt: expect.any(Date),
      }),
    });
  });
});
