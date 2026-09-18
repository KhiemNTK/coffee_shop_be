import { BadRequestException, ConflictException } from '@nestjs/common';
import { ReservationStatus } from '@prisma/client';
import type { ExtendedPrismaClient } from '../../common/prisma/prisma.service';
import { ReservationsService } from './reservations.service';
import type { OrdersService } from '../orders/orders.service';

describe('ReservationsService', () => {
  const startsAt = new Date(Date.now() + 60 * 60 * 1000);
  const endsAt = new Date(startsAt.getTime() + 60 * 60 * 1000);
  const includeResult = {
    id: 1,
    tableId: 'table-id',
    employeeId: 'employee-id',
    startsAt,
    endsAt,
    status: ReservationStatus.PENDING,
  };
  const tx = {
    employee: { findFirst: jest.fn() },
    diningTable: { findFirst: jest.fn() },
    reservation: {
      create: jest.fn(),
      findUnique: jest.fn(),
      findUniqueOrThrow: jest.fn(),
      updateMany: jest.fn(),
    },
    actionLog: { create: jest.fn() },
  };
  const prisma = {
    $transaction: jest.fn(),
    reservation: {
      count: jest.fn(),
      findMany: jest.fn(),
      findUnique: jest.fn(),
      updateMany: jest.fn(),
    },
  };
  const paginationUtil = {
    paging: jest.fn(),
  };
  const ordersService = { checkInReservation: jest.fn() };
  let service: ReservationsService;

  beforeEach(() => {
    jest.clearAllMocks();
    prisma.$transaction.mockImplementation(
      async (callback: (client: typeof tx) => Promise<unknown>) => callback(tx),
    );
    tx.employee.findFirst.mockResolvedValue({ id: 'employee-id' });
    tx.diningTable.findFirst.mockResolvedValue({ id: 'table-id' });
    tx.reservation.create.mockResolvedValue(includeResult);
    tx.actionLog.create.mockResolvedValue({ id: 'log-id' });

    service = new ReservationsService(
      prisma as unknown as ExtendedPrismaClient,
      paginationUtil,
      ordersService as unknown as OrdersService,
    );
  });

  it('creates a future reservation and audit entry atomically', async () => {
    const result = await service.create('employee-id', {
      phoneNumber: '0900000000',
      tableId: 'table-id',
      startsAt,
      endsAt,
      guestCount: 2,
    });

    expect(result).toBe(includeResult);
    expect(tx.reservation.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ employeeId: 'employee-id' }),
      }),
    );
    expect(tx.actionLog.create).toHaveBeenCalledTimes(1);
  });

  it('rejects reservation windows shorter than 15 minutes', async () => {
    await expect(
      service.create('employee-id', {
        phoneNumber: '0900000000',
        tableId: 'table-id',
        startsAt,
        endsAt: new Date(startsAt.getTime() + 14 * 60 * 1000),
        guestCount: 2,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('rejects updates after the reservation leaves PENDING', async () => {
    tx.reservation.findUnique.mockResolvedValue({
      ...includeResult,
      status: ReservationStatus.ARRIVED,
    });

    await expect(
      service.update(1, 'employee-id', { notes: 'Window seat' }),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(tx.reservation.updateMany).not.toHaveBeenCalled();
  });

  it('cancels a pending reservation without deleting history', async () => {
    tx.reservation.findUnique.mockResolvedValue(includeResult);
    tx.reservation.updateMany.mockResolvedValue({ count: 1 });
    tx.reservation.findUniqueOrThrow.mockResolvedValue({
      ...includeResult,
      status: ReservationStatus.CANCELLED,
    });

    const result = await service.cancel(1, 'employee-id', {
      reason: 'Customer requested cancellation',
    });

    expect(result.status).toBe(ReservationStatus.CANCELLED);
    expect(tx.reservation.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: ReservationStatus.CANCELLED,
          cancellationReason: 'Customer requested cancellation',
        }),
      }),
    );
    expect(tx.actionLog.create).toHaveBeenCalledTimes(1);
  });

  it('marks only overdue pending reservations as no-show', async () => {
    const now = new Date('2026-09-19T10:00:00.000Z');
    prisma.reservation.updateMany.mockResolvedValue({ count: 2 });

    await expect(service.markOverdueNoShows(now)).resolves.toBe(2);
    expect(prisma.reservation.updateMany).toHaveBeenCalledWith({
      where: {
        status: ReservationStatus.PENDING,
        startsAt: { lte: new Date('2026-09-19T09:45:00.000Z') },
      },
      data: {
        status: ReservationStatus.NO_SHOW,
        noShowAt: now,
      },
    });
  });
});
