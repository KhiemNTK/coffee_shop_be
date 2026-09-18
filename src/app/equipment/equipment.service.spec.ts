import { BadRequestException, ConflictException } from '@nestjs/common';
import { EquipmentStatus, Prisma } from '@prisma/client';
import type { ExtendedPrismaClient } from '../../common/prisma/prisma.service';
import { EquipmentService } from './equipment.service';

describe('EquipmentService', () => {
  const purchaseDate = new Date('2026-01-01T00:00:00.000Z');
  const equipment = {
    id: 'equipment-id',
    assetCode: 'EQ-001',
    serialNumber: null,
    name: 'Espresso machine',
    quantity: 2,
    unitPrice: new Prisma.Decimal('1000'),
    totalAmount: new Prisma.Decimal('2000'),
    purchaseDate,
    warrantyExpiresAt: null,
    status: EquipmentStatus.IN_USE,
  };
  const tx = {
    employee: { findFirst: jest.fn() },
    equipment: {
      create: jest.fn(),
      findFirst: jest.fn(),
      findUniqueOrThrow: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn(),
    },
    equipmentLifecycleEvent: { create: jest.fn() },
    actionLog: { create: jest.fn() },
  };
  const prisma = {
    $transaction: jest.fn(),
    equipment: { count: jest.fn(), findMany: jest.fn(), findFirst: jest.fn() },
    equipmentLifecycleEvent: { count: jest.fn(), findMany: jest.fn() },
  };
  const paginationUtil = { paging: jest.fn() };
  let service: EquipmentService;

  beforeEach(() => {
    jest.clearAllMocks();
    prisma.$transaction.mockImplementation(
      async (callback: (client: typeof tx) => Promise<unknown>) => callback(tx),
    );
    tx.employee.findFirst.mockResolvedValue({ id: 'employee-id' });
    tx.equipment.create.mockResolvedValue(equipment);
    tx.equipmentLifecycleEvent.create.mockResolvedValue({ id: 'event-id' });
    tx.actionLog.create.mockResolvedValue({ id: 'log-id' });

    service = new EquipmentService(
      prisma as unknown as ExtendedPrismaClient,
      paginationUtil,
    );
  });

  it('creates equipment with an exact total and initial lifecycle event', async () => {
    await expect(
      service.create('employee-id', {
        assetCode: 'EQ-001',
        name: 'Espresso machine',
        quantity: 2,
        unitPrice: '1000.00',
        purchaseDate,
      }),
    ).resolves.toBe(equipment);

    expect(tx.equipment.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          unitPrice: new Prisma.Decimal('1000.00'),
          totalAmount: new Prisma.Decimal('2000.00'),
          employeeId: 'employee-id',
        }),
      }),
    );
    expect(tx.equipmentLifecycleEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        toStatus: EquipmentStatus.IN_USE,
      }),
    });
    expect(tx.actionLog.create).toHaveBeenCalledTimes(1);
  });

  it('rejects warranty dates before purchase without opening a transaction', async () => {
    await expect(
      service.create('employee-id', {
        assetCode: 'EQ-001',
        name: 'Espresso machine',
        quantity: 1,
        unitPrice: '1000',
        purchaseDate,
        warrantyExpiresAt: new Date('2025-12-31T00:00:00.000Z'),
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('rejects lifecycle transitions that bypass maintenance', async () => {
    tx.equipment.findFirst.mockResolvedValue({
      ...equipment,
      status: EquipmentStatus.BROKEN,
    });

    await expect(
      service.transition('equipment-id', 'employee-id', {
        status: EquipmentStatus.IN_USE,
        reason: 'Direct repair',
        cost: '0',
      }),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(tx.equipment.updateMany).not.toHaveBeenCalled();
  });

  it('records a valid lifecycle transition atomically', async () => {
    tx.equipment.findFirst.mockResolvedValue(equipment);
    tx.equipment.updateMany.mockResolvedValue({ count: 1 });
    tx.equipmentLifecycleEvent.create.mockResolvedValue({
      id: 'event-id',
      fromStatus: EquipmentStatus.IN_USE,
      toStatus: EquipmentStatus.MAINTENANCE,
    });
    tx.equipment.findUniqueOrThrow.mockResolvedValue({
      ...equipment,
      status: EquipmentStatus.MAINTENANCE,
    });

    const result = await service.transition('equipment-id', 'employee-id', {
      status: EquipmentStatus.MAINTENANCE,
      reason: 'Scheduled service',
      cost: '125.50',
      occurredAt: new Date('2026-02-01T00:00:00.000Z'),
    });

    expect(result.equipment.status).toBe(EquipmentStatus.MAINTENANCE);
    expect(tx.equipment.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ status: EquipmentStatus.IN_USE }),
      }),
    );
    expect(tx.equipmentLifecycleEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          cost: new Prisma.Decimal('125.50'),
        }),
      }),
    );
  });
});
