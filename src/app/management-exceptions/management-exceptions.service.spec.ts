import type { ExtendedPrismaClient } from '../../common/prisma/prisma.service';
import { PaginationUtilService } from '../../common/utils/pagination-util/pagination-util.service';
import { ManagementExceptionsService } from './management-exceptions.service';
import { IdempotencyService } from '../durable/idempotency.service';
import { RetryOutboxEventDto } from './dto/retry-outbox-event.dto';
import {
  ConflictException,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { ManagementExceptionsController } from './management-exceptions.controller';
import { REQUIRED_PERMISSIONS_KEY } from '../authorization/authorization.decorator';
import { PermissionKeys } from '../../common/consts/permission-keys';
import { fulfillmentWhere } from '../online-orders/fulfillment-where';

describe('ManagementExceptionsService', () => {
  const prisma = {
    paymentReconciliationIncident: {
      count: jest.fn(),
      findMany: jest.fn(),
    },
    cashExpenseRequest: { count: jest.fn(), findMany: jest.fn() },
    cashHandover: { count: jest.fn(), findMany: jest.fn() },
    takeawayFeedback: { count: jest.fn(), findMany: jest.fn() },
    kitchenTicket: { count: jest.fn(), findMany: jest.fn() },
    onlineOrderRequest: { count: jest.fn(), findMany: jest.fn() },
    printJob: { count: jest.fn(), findMany: jest.fn() },
    outboxEvent: {
      count: jest.fn(),
      findMany: jest.fn(),
      findUnique: jest.fn(),
      updateMany: jest.fn(),
    },
    employee: { findFirst: jest.fn() },
    actionLog: { create: jest.fn() },
  };
  const idempotency = {
    execute: jest.fn(
      (_input: unknown, operation: (tx: typeof prisma) => unknown) =>
        operation(prisma),
    ),
  };
  const service = new ManagementExceptionsService(
    prisma as unknown as ExtendedPrismaClient,
    new PaginationUtilService(),
    idempotency as unknown as IdempotencyService,
  );

  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(new Date('2026-10-11T10:00:00Z'));
    jest.clearAllMocks();
    prisma.paymentReconciliationIncident.count.mockResolvedValue(2);
    prisma.cashExpenseRequest.count.mockResolvedValue(3);
    prisma.cashHandover.count.mockResolvedValue(4);
    prisma.takeawayFeedback.count.mockResolvedValue(5);
    prisma.kitchenTicket.count.mockResolvedValue(6);
    prisma.onlineOrderRequest.count.mockResolvedValue(7);
    prisma.outboxEvent.count.mockResolvedValue(8);
    prisma.printJob.count.mockResolvedValue(9);
    prisma.printJob.findMany.mockResolvedValue([]);
    prisma.outboxEvent.findMany.mockResolvedValue([]);
    prisma.employee.findFirst.mockResolvedValue({ id: 'employee-id' });
    prisma.outboxEvent.findUnique.mockResolvedValue({
      status: 'DEAD_LETTER',
      attempts: 5,
      availableAt: new Date('2026-10-11T09:00:00Z'),
    });
    prisma.outboxEvent.updateMany.mockResolvedValue({ count: 1 });
    prisma.actionLog.create.mockResolvedValue({ id: 'audit-id' });
    prisma.paymentReconciliationIncident.findMany.mockResolvedValue([]);
    prisma.cashExpenseRequest.findMany.mockResolvedValue([]);
    prisma.cashHandover.findMany.mockResolvedValue([]);
    prisma.takeawayFeedback.findMany.mockResolvedValue([]);
    prisma.kitchenTicket.findMany.mockResolvedValue([]);
    prisma.onlineOrderRequest.findMany.mockResolvedValue([]);
  });

  afterEach(() => jest.useRealTimers());

  it('counts only active cases without copying state into another table', async () => {
    expect(await service.summary()).toEqual({
      asOf: '2026-10-11T10:00:00.000Z',
      counts: {
        PAYMENT: 2,
        CASH_EXPENSE: 3,
        CASH_HANDOVER: 4,
        FEEDBACK: 5,
        KITCHEN_OVERDUE: 6,
        ONLINE_PICKUP_LATE: 7,
        OUTBOX_DEAD_LETTER: 8,
        PRINT_REVIEW: 9,
      },
      total: 44,
    });
    expect(prisma.paymentReconciliationIncident.count).toHaveBeenCalledWith({
      where: { status: 'OPEN' },
    });
    expect(prisma.cashExpenseRequest.count).toHaveBeenCalledWith({
      where: { status: 'PENDING' },
    });
    expect(prisma.cashHandover.count).toHaveBeenCalledWith({
      where: {
        OR: [
          { status: 'PENDING' },
          { status: 'APPROVED', settlementStatus: 'PENDING' },
        ],
      },
    });
    expect(prisma.takeawayFeedback.count).toHaveBeenCalledWith({
      where: { rating: { lte: 2 }, resolvedAt: null },
    });
  });

  it.each([
    ['PAYMENT', prisma.paymentReconciliationIncident, 'detectedAt', 2],
    ['CASH_EXPENSE', prisma.cashExpenseRequest, 'createdAt', 3],
    ['CASH_HANDOVER', prisma.cashHandover, 'createdAt', 4],
    ['FEEDBACK', prisma.takeawayFeedback, 'createdAt', 5],
    ['KITCHEN_OVERDUE', prisma.kitchenTicket, 'dueAt', 6],
    ['ONLINE_PICKUP_LATE', prisma.onlineOrderRequest, 'createdAt', 7],
    ['OUTBOX_DEAD_LETTER', prisma.outboxEvent, 'occurredAt', 8],
    ['PRINT_REVIEW', prisma.printJob, 'updatedAt', 9],
  ] as const)('paginates %s oldest first', async (kind, model, date, total) => {
    const result = await service.findAll({ kind, page: 2, itemPerPage: 2 });

    expect(model.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        skip: 2,
        take: 2,
        orderBy: [{ [date]: 'asc' }, { id: 'asc' }],
      }),
    );
    expect(result).toEqual({
      kind,
      list: [],
      totalItems: total,
      currentPage: 2,
      totalPages: Math.ceil(total / 2),
    });
  });

  it('returns minimal payment fields without provider payloads', async () => {
    await service.findAll({ kind: 'PAYMENT', page: 1, itemPerPage: 20 });

    expect(prisma.paymentReconciliationIncident.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        select: {
          id: true,
          type: true,
          title: true,
          detectedAt: true,
          paymentAttemptId: true,
          paymentRefundId: true,
        },
      }),
    );
  });

  const dto = {
    reason: 'Fixed the failing consumer',
    expectedAvailableAt: '2026-10-11T09:00:00.000Z',
    idempotencyKey: 'retry-key',
  };

  it('does not expose outbox payloads or raw delivery errors', async () => {
    await service.findAll({
      kind: 'OUTBOX_DEAD_LETTER',
      page: 1,
      itemPerPage: 20,
    });
    expect(prisma.outboxEvent.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { status: 'DEAD_LETTER' },
        select: {
          id: true,
          topic: true,
          eventName: true,
          aggregateType: true,
          aggregateId: true,
          status: true,
          attempts: true,
          occurredAt: true,
          availableAt: true,
          lastErrorCode: true,
          lastFailedAt: true,
          context: true,
        },
      }),
    );
  });

  it('exposes only the original request ID from delivery context', async () => {
    prisma.outboxEvent.findMany.mockResolvedValue([
      {
        id: 'event-id',
        lastErrorCode: 'PERMANENT_REJECTION',
        lastFailedAt: new Date(),
        context: {
          requestId: 'original-request-id',
          employeeId: 'private-actor',
          tracestate: 'private-state',
        },
      },
    ]);
    const result = await service.findAll({
      kind: 'OUTBOX_DEAD_LETTER',
      page: 1,
      itemPerPage: 20,
    });
    expect(result.list).toEqual([
      expect.objectContaining({ requestId: 'original-request-id' }),
    ]);
    expect(JSON.stringify(result)).not.toMatch(
      /context|private-actor|private-state/,
    );
  });

  it('lists uncertain print delivery without exposing document payload or device keys', async () => {
    await service.findAll({ kind: 'PRINT_REVIEW', page: 1, itemPerPage: 20 });
    expect(prisma.printJob.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { status: 'REQUIRES_REVIEW' },
        select: {
          id: true,
          type: true,
          status: true,
          attempts: true,
          createdAt: true,
          updatedAt: true,
          invoiceId: true,
          kitchenTicketId: true,
          device: { select: { name: true } },
        },
      }),
    );
  });

  it('conditionally requeues a dead letter with an idempotent audit, preserving its payload and last error', async () => {
    expect(
      await service.retryOutboxEvent('event-id', 'employee-id', dto),
    ).toEqual({ id: 'event-id', status: 'PENDING' });
    expect(idempotency.execute).toHaveBeenCalledWith(
      {
        employeeId: 'employee-id',
        operation: 'management.outbox.retry',
        key: dto.idempotencyKey,
        request: {
          id: 'event-id',
          reason: dto.reason,
          expectedAvailableAt: dto.expectedAvailableAt,
        },
      },
      expect.any(Function),
    );
    expect(prisma.outboxEvent.updateMany).toHaveBeenCalledWith({
      where: {
        id: 'event-id',
        status: 'DEAD_LETTER',
        availableAt: new Date(dto.expectedAvailableAt),
      },
      data: {
        status: 'PENDING',
        attempts: 0,
        availableAt: expect.any(Date),
        lockedAt: null,
        lockedBy: null,
      },
    });
    expect(prisma.actionLog.create).toHaveBeenCalledWith({
      data: {
        employeeId: 'employee-id',
        actionType: 'OUTBOX_EVENT_RETRY',
        details: {
          outboxEventId: 'event-id',
          reason: dto.reason,
          previousStatus: 'DEAD_LETTER',
          previousAttempts: 5,
          previousAvailableAt: dto.expectedAvailableAt,
          status: 'PENDING',
        },
      },
    });
  });

  it('rejects stale or non-dead-letter state without an audit', async () => {
    prisma.outboxEvent.updateMany.mockResolvedValue({ count: 0 });
    await expect(
      service.retryOutboxEvent('event-id', 'employee-id', dto),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(prisma.actionLog.create).not.toHaveBeenCalled();
  });

  it('rejects missing events and inactive employees', async () => {
    prisma.outboxEvent.findUnique.mockResolvedValue(null);
    await expect(
      service.retryOutboxEvent('event-id', 'employee-id', dto),
    ).rejects.toBeInstanceOf(NotFoundException);
    prisma.employee.findFirst.mockResolvedValue(null);
    await expect(
      service.retryOutboxEvent('event-id', 'employee-id', dto),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(prisma.actionLog.create).not.toHaveBeenCalled();
  });

  it('requires both queue visibility and a separate retry permission', () => {
    expect(
      Reflect.getMetadata(
        REQUIRED_PERMISSIONS_KEY,
        Reflect.get(
          ManagementExceptionsController.prototype,
          'retryOutboxEvent',
        ) as object,
      ),
    ).toEqual([
      PermissionKeys.MANAGEMENT_EXCEPTIONS_READ,
      PermissionKeys.OUTBOX_EVENTS_RETRY,
    ]);
  });

  it('validates and normalizes retry input without accepting payload edits', () => {
    expect(
      RetryOutboxEventDto.schema.parse({
        ...dto,
        reason: '  Fixed consumer  ',
        payload: { evil: true },
      }),
    ).toEqual({ ...dto, reason: 'Fixed consumer' });
    for (const invalid of [
      { ...dto, reason: '  ' },
      { ...dto, reason: 'a'.repeat(501) },
      { ...dto, expectedAvailableAt: 'tomorrow' },
      { ...dto, idempotencyKey: 'short' },
    ]) {
      expect(RetryOutboxEventDto.schema.safeParse(invalid).success).toBe(false);
    }
  });

  it('excludes future scheduled, finished and deleted-station kitchen tickets', async () => {
    await service.summary();
    const where = {
      dueAt: { lt: new Date('2026-10-11T10:00:00Z') },
      OR: [
        { availableAt: null },
        { availableAt: { lte: new Date('2026-10-11T10:00:00Z') } },
      ],
      station: { deletedAt: null },
      items: {
        some: { orderItem: { serveStatus: { in: ['PENDING', 'COOKING'] } } },
      },
    };
    expect(prisma.kitchenTicket.count).toHaveBeenCalledWith({ where });
    await service.findAll({
      kind: 'KITCHEN_OVERDUE',
      page: 1,
      itemPerPage: 20,
    });
    expect(prisma.kitchenTicket.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where }),
    );
  });

  it('uses the fulfillment grace window without treating late orders as no-shows', async () => {
    await service.summary();
    const where = fulfillmentWhere(new Date());
    expect(where.OR).toEqual(
      expect.arrayContaining([
        { pickupAt: { lt: new Date('2026-10-11T09:45:00Z') } },
        expect.objectContaining({ pickupAt: null }),
      ]),
    );
    expect(prisma.onlineOrderRequest.count).toHaveBeenCalledWith({ where });
    await service.findAll({
      kind: 'ONLINE_PICKUP_LATE',
      page: 1,
      itemPerPage: 20,
    });
    expect(prisma.onlineOrderRequest.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where,
        select: {
          id: true,
          pickupAt: true,
          createdAt: true,
          orderSessionId: true,
        },
      }),
    );
  });
});
