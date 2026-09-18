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
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { OrderPolicyService } from './order-policy.service';
import { InventoryConsumptionService } from '../inventory/services/inventory-consumption.service';

describe('OrdersService', () => {
  let service: OrdersService;
  let prisma: any;
  let tx: any;
  let orderEventsPublisher: { emit: jest.Mock; on: jest.Mock };
  let inventoryConsumption: {
    consumeOrderItem: jest.Mock;
    emitConsumption: jest.Mock;
    recordWaste: jest.Mock;
  };

  beforeEach(async () => {
    tx = {
      employee: {
        findUnique: jest.fn(),
        findFirst: jest.fn().mockResolvedValue({ id: 'employee-id' }),
      },
      cashierShift: {
        findUnique: jest.fn(),
      },
      diningTable: {
        findUnique: jest.fn(),
        findFirst: jest.fn(),
        updateMany: jest.fn(),
      },
      reservation: {
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
      actionLog: {
        create: jest.fn(),
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
    inventoryConsumption = {
      consumeOrderItem: jest.fn().mockResolvedValue([]),
      emitConsumption: jest.fn(),
      recordWaste: jest.fn().mockResolvedValue([]),
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
        {
          provide: InventoryConsumptionService,
          useValue: inventoryConsumption,
        },
      ],
    }).compile();

    service = module.get<OrdersService>(OrdersService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  it('rejects skipping directly from pending to served', async () => {
    tx.employee.findFirst.mockResolvedValue({ id: 'employee-id' });
    tx.orderItem.findUnique.mockResolvedValue({
      id: 'order-item-id',
      isPaid: false,
      invoiceId: null,
      serveStatus: ServeStatus.PENDING,
      orderSession: { sessionStatus: SessionStatus.ACTIVE },
    });

    await expect(
      service.updateItemStatus('order-item-id', 'employee-id', {
        serveStatus: ServeStatus.SERVED,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(tx.orderItem.updateMany).not.toHaveBeenCalled();
    expect(inventoryConsumption.consumeOrderItem).not.toHaveBeenCalled();
  });

  it('consumes inventory once when an item starts cooking', async () => {
    const pendingItem = {
      id: 'order-item-id',
      menuItemId: 'menu-item-id',
      quantity: 2,
      isPaid: false,
      invoiceId: null,
      serveStatus: ServeStatus.PENDING,
      orderSessionId: 'session-id',
      orderSession: {
        sessionStatus: SessionStatus.ACTIVE,
        tableId: 'table-id',
      },
      menuItem: { id: 'menu-item-id', name: 'Latte' },
    };
    const movement = {
      inventoryItemId: 'inventory-id',
      transactionId: 'transaction-id',
      type: 'EXPORT',
      quantity: new Prisma.Decimal('0.5'),
      stockAfter: new Prisma.Decimal('9.5'),
    };
    tx.orderItem.findUnique
      .mockResolvedValueOnce(pendingItem)
      .mockResolvedValueOnce({
        ...pendingItem,
        serveStatus: ServeStatus.COOKING,
      });
    tx.orderItem.updateMany.mockResolvedValue({ count: 1 });
    inventoryConsumption.consumeOrderItem.mockResolvedValue([movement]);

    const result = await service.updateItemStatus(
      'order-item-id',
      'employee-id',
      { serveStatus: ServeStatus.COOKING },
    );

    expect(inventoryConsumption.consumeOrderItem).toHaveBeenCalledWith(
      tx,
      pendingItem,
    );
    expect(tx.actionLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          actionType: 'ORDER_ITEM_STATUS_UPDATED',
        }),
      }),
    );
    expect(inventoryConsumption.emitConsumption).toHaveBeenCalledWith([
      movement,
    ]);
    expect(orderEventsPublisher.emit).toHaveBeenCalledTimes(1);
    expect(result.serveStatus).toBe(ServeStatus.COOKING);
  });

  it('treats a repeated cooking status request as a no-op', async () => {
    const cookingItem = {
      id: 'order-item-id',
      menuItemId: 'menu-item-id',
      quantity: 1,
      isPaid: false,
      invoiceId: null,
      serveStatus: ServeStatus.COOKING,
      orderSessionId: 'session-id',
      orderSession: {
        sessionStatus: SessionStatus.ACTIVE,
        tableId: 'table-id',
      },
      menuItem: { id: 'menu-item-id', name: 'Latte' },
    };
    tx.orderItem.findUnique.mockResolvedValue(cookingItem);

    await expect(
      service.updateItemStatus('order-item-id', 'employee-id', {
        serveStatus: ServeStatus.COOKING,
      }),
    ).resolves.toEqual(cookingItem);

    expect(tx.orderItem.updateMany).not.toHaveBeenCalled();
    expect(inventoryConsumption.consumeOrderItem).not.toHaveBeenCalled();
    expect(tx.actionLog.create).not.toHaveBeenCalled();
    expect(orderEventsPublisher.emit).not.toHaveBeenCalled();
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
      service.cancelItem('order-item-id', 'employee-id', {
        reason: 'Wrong item',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(tx.orderItem.updateMany).not.toHaveBeenCalled();
    expect(orderEventsPublisher.emit).not.toHaveBeenCalled();
  });

  it('requires a reason before cancelling a prepared item', async () => {
    tx.orderItem.findUnique.mockResolvedValue({
      id: 'order-item-id',
      isPaid: false,
      invoiceId: null,
      serveStatus: ServeStatus.COOKING,
      orderSessionId: 'session-id',
      orderSession: {
        sessionStatus: SessionStatus.ACTIVE,
        tableId: 'table-id',
      },
    });

    await expect(
      service.cancelItem('order-item-id', 'employee-id', {}),
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(tx.orderItem.updateMany).not.toHaveBeenCalled();
    expect(inventoryConsumption.recordWaste).not.toHaveBeenCalled();
  });

  it('records waste when cancelling a prepared item', async () => {
    const cookingItem = {
      id: 'order-item-id',
      isPaid: false,
      invoiceId: null,
      note: null,
      serveStatus: ServeStatus.COOKING,
      orderSessionId: 'session-id',
      orderSession: {
        sessionStatus: SessionStatus.ACTIVE,
        tableId: 'table-id',
      },
    };
    tx.orderItem.findUnique
      .mockResolvedValueOnce(cookingItem)
      .mockResolvedValueOnce({
        ...cookingItem,
        serveStatus: ServeStatus.CANCELLED,
      });
    tx.orderItem.updateMany.mockResolvedValue({ count: 1 });
    inventoryConsumption.recordWaste.mockResolvedValue([
      {
        id: 'waste-id',
        inventoryItemId: 'inventory-id',
        quantity: new Prisma.Decimal('0.5'),
      },
    ]);

    await service.cancelItem('order-item-id', 'employee-id', {
      reason: 'Customer changed order',
    });

    expect(inventoryConsumption.recordWaste).toHaveBeenCalledWith(tx, {
      orderItemId: 'order-item-id',
      employeeId: 'employee-id',
      reason: 'Customer changed order',
    });
    expect(tx.actionLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ actionType: 'ORDER_ITEM_CANCELLED' }),
      }),
    );
    expect(orderEventsPublisher.emit).toHaveBeenCalledTimes(1);
  });

  it('only adds active and available menu items to an order', async () => {
    tx.orderSession.findUnique.mockResolvedValue({
      id: 'session-id',
      sessionStatus: SessionStatus.ACTIVE,
    });
    tx.menuItem.findMany.mockResolvedValue([]);

    await expect(
      service.addOrderItems('session-id', {
        items: [{ menuItemId: 'menu-item-id', quantity: 1 }],
      }),
    ).rejects.toBeInstanceOf(NotFoundException);

    expect(tx.menuItem.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: { in: ['menu-item-id'] },
          deletedAt: null,
          isAvailable: true,
        },
      }),
    );
    expect(tx.orderItem.createManyAndReturn).not.toHaveBeenCalled();
  });

  it('does not open a session when the table cannot be claimed', async () => {
    tx.employee.findUnique.mockResolvedValue({ id: 'employee-id' });
    tx.diningTable.findFirst.mockResolvedValue({
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
    tx.diningTable.findFirst.mockResolvedValue({
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

  it('checks in a reservation and opens its order session atomically', async () => {
    const session = {
      id: 'session-id',
      tableId: 'table-id',
      employeeId: 'employee-id',
      shiftId: null,
    };
    tx.reservation.findUnique.mockResolvedValue({
      id: 1,
      tableId: 'table-id',
      guestCount: 3,
      startsAt: new Date(Date.now() + 5 * 60 * 1000),
      endsAt: new Date(Date.now() + 65 * 60 * 1000),
      status: 'PENDING',
      orderSessionId: null,
      table: { id: 'table-id', name: 'A1', status: TableStatus.EMPTY },
    });
    tx.diningTable.findFirst.mockResolvedValue({
      id: 'table-id',
      name: 'A1',
      status: TableStatus.EMPTY,
    });
    tx.diningTable.updateMany.mockResolvedValue({ count: 1 });
    tx.orderSession.create.mockResolvedValue(session);
    tx.reservation.updateMany.mockResolvedValue({ count: 1 });

    const result = await service.checkInReservation(1, 'employee-id');

    expect(result.orderSession).toBe(session);
    expect(tx.reservation.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: 'ARRIVED',
          orderSessionId: 'session-id',
        }),
      }),
    );
    expect(tx.actionLog.create).toHaveBeenCalledTimes(1);
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

  it('rejects partially splitting a processed item', async () => {
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
        menuItemId: 'menu-item-id',
        orderSessionId: 'source-session-id',
        isPaid: false,
        invoiceId: null,
        serveStatus: ServeStatus.COOKING,
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
  });
});
