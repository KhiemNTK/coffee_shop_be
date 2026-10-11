import {
  BadRequestException,
  ConflictException,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { SettingValueType } from '@prisma/client';
import { UpdateOnlineOrderIntakeDto } from './dto';
import { OnlineOrderIntakeService } from './online-order-intake.service';

describe('OnlineOrderIntakeService', () => {
  const tx = {
    employee: { findFirst: jest.fn() },
    systemSetting: {
      findUnique: jest.fn(),
      create: jest.fn(),
      updateMany: jest.fn(),
      findUniqueOrThrow: jest.fn(),
    },
    systemSettingRevision: { create: jest.fn() },
    actionLog: { create: jest.fn() },
  };
  const prisma = { ...tx, $transaction: jest.fn((fn) => fn(tx)) };
  const service = new OnlineOrderIntakeService(prisma as never);
  const pause = {
    expectedVersion: 0,
    pausedUntil: new Date(Date.now() + 60_000).toISOString(),
    reason: 'Kitchen busy',
  };

  beforeEach(() => {
    jest.clearAllMocks();
    tx.employee.findFirst.mockResolvedValue({ id: 'employee' });
    tx.systemSetting.findUnique.mockResolvedValue(null);
  });

  it('starts open and automatically expires a stored pause', async () => {
    expect(await service.getStatus()).toMatchObject({
      acceptingOrders: true,
      version: 0,
    });
    tx.systemSetting.findUnique.mockResolvedValue({
      valueType: SettingValueType.JSON,
      version: 1,
      value: {
        pausedUntil: new Date(Date.now() - 1_000).toISOString(),
        reason: 'Kitchen busy',
      },
    });
    expect(await service.getAvailability()).toEqual({
      acceptingOrders: true,
      pausedUntil: null,
      reason: null,
    });
  });

  it.each([null, {}, { pausedUntil: 'invalid', reason: 'Busy' }])(
    'fails closed for malformed stored value %j',
    async (value) => {
      tx.systemSetting.findUnique.mockResolvedValue({
        valueType: SettingValueType.JSON,
        value,
        version: 1,
      });
      await expect(service.getStatus()).rejects.toBeInstanceOf(
        ServiceUnavailableException,
      );
    },
  );

  it('rejects new orders while paused', async () => {
    tx.systemSetting.findUnique.mockResolvedValue({
      valueType: SettingValueType.JSON,
      version: 1,
      value: { pausedUntil: pause.pausedUntil, reason: pause.reason },
    });
    await expect(service.assertAccepting(tx as never)).rejects.toBeInstanceOf(
      ConflictException,
    );
  });

  it('rejects inactive actors, stale versions, and unbounded pauses before writing', async () => {
    tx.employee.findFirst.mockResolvedValueOnce(null);
    await expect(service.update('employee', pause)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    await expect(
      service.update('employee', { ...pause, expectedVersion: 1 }),
    ).rejects.toBeInstanceOf(ConflictException);
    await expect(
      service.update('employee', {
        ...pause,
        pausedUntil: new Date(Date.now() + 25 * 60 * 60_000).toISOString(),
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(tx.systemSetting.create).not.toHaveBeenCalled();
  });

  it('writes the setting, revision and audit in one serializable transaction', async () => {
    const value = { pausedUntil: pause.pausedUntil, reason: pause.reason };
    const setting = {
      id: 'setting',
      version: 1,
      value,
      valueType: SettingValueType.JSON,
      isPublic: false,
    };
    tx.systemSetting.findUniqueOrThrow.mockResolvedValue(setting);
    tx.systemSetting.findUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(setting);
    expect(await service.update('employee', pause)).toMatchObject({
      acceptingOrders: false,
      version: 1,
    });
    expect(prisma.$transaction).toHaveBeenCalledWith(expect.any(Function), {
      isolationLevel: 'Serializable',
    });
    expect(tx.systemSettingRevision.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        settingId: 'setting',
        value,
        version: 1,
      }),
    });
    expect(tx.actionLog.create).toHaveBeenCalledTimes(1);
  });

  it('validates the pause/reason pair at the API boundary', () => {
    expect(
      UpdateOnlineOrderIntakeDto.schema.safeParse({ ...pause, reason: null })
        .success,
    ).toBe(false);
    expect(
      UpdateOnlineOrderIntakeDto.schema.safeParse({
        expectedVersion: 1,
        pausedUntil: null,
        reason: null,
      }).success,
    ).toBe(true);
  });
});
