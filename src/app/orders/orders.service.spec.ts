import { Test, TestingModule } from '@nestjs/testing';
import { OrdersService } from './orders.service';
import { PRISMA_SERVICE_TOKEN } from '../../common/prisma/prisma.service';
import { OrderEventsPublisher } from './events/order-events.publisher';
import {
  Prisma,
  ServeStatus,
  SessionStatus,
  TableStatus,
} from '@prisma/client';
import { BadRequestException } from '@nestjs/common';
import { OrderPolicyService } from './order-policy.service';

describe('OrdersService', () => {
  let service: OrdersService;
  let prisma: any;
  let tx: any;
  let orderEventsPublisher: { emit: jest.Mock; on: jest.Mock };

  beforeEach(async () => {
    tx = {
      employee: {
        findUnique: jest.fn(),
      },
      cashierShift: {
        findUnique: jest.fn(),
      },
      diningTable: {
        findUnique: jest.fn(),
        updateMany: jest.fn(),
      },
      orderSession: {
        create: jest.fn(),
        findFirst: jest.fn(),
        findMany: jest.fn(),
        findUnique: jest.fn(),
        updateMany: jest.fn(),
      },
      orderItem: {
        create: jest.fn(),
        createManyAndReturn: jest.fn(),
        findMany: jest.fn(),
        findUnique: jest.fn(),
        updateMany: jest.fn(),
      },
      menuItem: {
        findMany: jest.fn(),
      },
    };

    prisma = {
      $transaction: jest.fn((callback: (transactionClient: any) => unknown) =>
        callback(tx),
      ),
      orderSession: {
        findMany: jest.fn(),
        findUnique: jest.fn(),
      },
    };

    orderEventsPublisher = {
      emit: jest.fn(),
      on: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        OrdersService,
        {
          provide: PRISMA_SERVICE_TOKEN,
          useValue: prisma,
        },
        {
          provide: OrderEventsPublisher,
          useValue: orderEventsPublisher,
        },
        OrderPolicyService,
      ],
    }).compile();

    service = module.get<OrdersService>(OrdersService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  it('rejects cancelling an item through updateItemStatus', async () => {
    await expect(
      service.updateItemStatus('order-item-id', {
        serveStatus: ServeStatus.CANCELLED,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('rejects cancelling a paid order item', async () => {
    tx.orderItem.findUnique.mockResolvedValue({
      id: 'order-item-id',
      isPaid: true,
      invoiceId: null,
      serveStatus: ServeStatus.PENDING,
      orderSessionId: 'session-id',
      orderSession: {
        sessionStatus: SessionStatus.ACTIVE,
        tableId: 'table-id',
      },
    });

    await expect(
      service.cancelItem('order-item-id', { reason: 'Wrong item' }),
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(tx.orderItem.updateMany).not.toHaveBeenCalled();
    expect(orderEventsPublisher.emit).not.toHaveBeenCalled();
  });

  it('does not open a session when the table cannot be claimed', async () => {
    tx.employee.findUnique.mockResolvedValue({ id: 'employee-id' });
    tx.diningTable.findUnique.mockResolvedValue({
      id: 'table-id',
      name: 'A1',
      status: TableStatus.EMPTY,
    });
    tx.diningTable.updateMany.mockResolvedValue({ count: 0 });

    await expect(
      service.openSession({
        tableId: 'table-id',
        employeeId: 'employee-id',
        guestCount: 2,
        shiftId: null,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(tx.orderSession.create).not.toHaveBeenCalled();
    expect(orderEventsPublisher.emit).not.toHaveBeenCalled();
  });

  it('retries serializable transaction conflicts', async () => {
    const conflict = new Prisma.PrismaClientKnownRequestError(
      'Transaction conflict',
      {
        code: 'P2034',
        clientVersion: 'test',
      },
    );
    const session = {
      id: 'session-id',
      tableId: 'table-id',
      employeeId: 'employee-id',
      shiftId: null,
    };

    prisma.$transaction
      .mockRejectedValueOnce(conflict)
      .mockImplementationOnce((callback: (transactionClient: any) => unknown) =>
        callback(tx),
      );
    tx.employee.findUnique.mockResolvedValue({ id: 'employee-id' });
    tx.diningTable.findUnique.mockResolvedValue({
      id: 'table-id',
      name: 'A1',
      status: TableStatus.EMPTY,
    });
    tx.diningTable.updateMany.mockResolvedValue({ count: 1 });
    tx.orderSession.findFirst.mockResolvedValue(null);
    tx.orderSession.create.mockResolvedValue(session);

    await expect(
      service.openSession({
        tableId: 'table-id',
        employeeId: 'employee-id',
        guestCount: 2,
        shiftId: null,
      }),
    ).resolves.toEqual(session);

    expect(prisma.$transaction).toHaveBeenCalledTimes(2);
    expect(orderEventsPublisher.emit).toHaveBeenCalledTimes(1);
  });

  it('rejects merging sessions that contain paid items', async () => {
    tx.orderSession.findFirst.mockResolvedValue({
      id: 'target-session-id',
      orderItems: [],
    });
    tx.orderSession.findMany.mockResolvedValue([
      {
        id: 'source-session-id',
        orderItems: [{ isPaid: true, invoiceId: null }],
      },
    ]);

    await expect(
      service.mergeTables({
        sourceTableIds: ['source-table-id'],
        destinationTableId: 'destination-table-id',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(tx.orderItem.updateMany).not.toHaveBeenCalled();
    expect(tx.orderSession.updateMany).not.toHaveBeenCalled();
    expect(orderEventsPublisher.emit).not.toHaveBeenCalled();
  });

  it('rejects splitting an item that does not belong to the source session', async () => {
    tx.diningTable.findUnique.mockResolvedValue({
      id: 'destination-table-id',
      status: TableStatus.EMPTY,
    });
    tx.orderSession.findUnique.mockResolvedValue({
      id: 'source-session-id',
      employeeId: 'employee-id',
      shiftId: 'shift-id',
      sessionStatus: SessionStatus.ACTIVE,
    });
    tx.orderSession.findFirst.mockResolvedValue(null);
    tx.orderItem.findMany.mockResolvedValue([
      {
        id: 'order-item-id',
        orderSessionId: 'another-session-id',
        isPaid: false,
        invoiceId: null,
        serveStatus: ServeStatus.PENDING,
        quantity: 2,
      },
    ]);

    await expect(
      service.splitTable({
        sourceOrderSessionId: 'source-session-id',
        destinationTableId: 'destination-table-id',
        itemsToMove: [
          {
            orderItemId: 'order-item-id',
            quantityToMove: 1,
            expectedOriginalQuantity: 2,
          },
        ],
      }),
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(tx.diningTable.updateMany).not.toHaveBeenCalled();
    expect(tx.orderSession.create).not.toHaveBeenCalled();
    expect(orderEventsPublisher.emit).not.toHaveBeenCalled();
  });
});
