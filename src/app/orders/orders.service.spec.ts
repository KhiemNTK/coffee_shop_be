import { Test, TestingModule } from '@nestjs/testing';
import { OrdersService } from './orders.service';
import { PRISMA_SERVICE_TOKEN } from '../../common/prisma/prisma.service';
import { OutboxService } from '../durable/outbox.service';
import {
  Prisma,
  ServeStatus,
  SessionStatus,
  TableStatus,
} from '@prisma/client';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { OrderPolicyService } from './order-policy.service';
import { InventoryConsumptionService } from '../inventory/services/inventory-consumption.service';
import { CashierShiftLedgerService } from '../cashier-shifts/cashier-shift-ledger.service';
import { KitchenRoutingService } from '../kitchen/kitchen-routing.service';
import { PaginationUtilService } from '../../common/utils/pagination-util/pagination-util.service';

describe('OrdersService', () => {
  let service: OrdersService;
  let prisma: any;
  let tx: any;
  let outbox: { enqueue: jest.Mock };
  let inventoryConsumption: {
    consumeOrderItem: jest.Mock;
    recordWaste: jest.Mock;
  };
  let cashierShiftLedger: { findOpenShiftId: jest.Mock };
  let kitchenRouting: { createTickets: jest.Mock };

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
      kitchenTicketItem: {
        findUnique: jest.fn(),
        update: jest.fn(),
        create: jest.fn(),
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
      orderItem: {
        count: jest.fn(),
        findMany: jest.fn(),
      },
    };

    outbox = { enqueue: jest.fn() };
    inventoryConsumption = {
      consumeOrderItem: jest.fn().mockResolvedValue([]),
      recordWaste: jest.fn().mockResolvedValue([]),
    };
    cashierShiftLedger = {
      findOpenShiftId: jest.fn().mockResolvedValue(null),
    };
    kitchenRouting = {
      createTickets: jest.fn().mockResolvedValue([]),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        OrdersService,
        {
          provide: PRISMA_SERVICE_TOKEN,
          useValue: prisma,
        },
        {
          provide: OutboxService,
          useValue: outbox,
        },
        OrderPolicyService,
        {
          provide: InventoryConsumptionService,
          useValue: inventoryConsumption,
        },
        {
          provide: CashierShiftLedgerService,
          useValue: cashierShiftLedger,
        },
        {
          provide: KitchenRoutingService,
          useValue: kitchenRouting,
        },
        PaginationUtilService,
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
    expect(outbox.enqueue).toHaveBeenCalledTimes(1);
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
    expect(outbox.enqueue).not.toHaveBeenCalled();
  });

  it('marks a paid item READY after its session has completed', async () => {
    const item = {
      id: 'order-item-id',
      menuItemId: 'menu-item-id',
      quantity: 1,
      isPaid: true,
      invoiceId: 'invoice-id',
      serveStatus: ServeStatus.COOKING,
      orderSessionId: 'session-id',
      orderSession: {
        sessionStatus: SessionStatus.COMPLETED,
        tableId: null,
      },
    };
    tx.orderItem.findUnique
      .mockResolvedValueOnce(item)
      .mockResolvedValueOnce({ ...item, serveStatus: ServeStatus.READY });
    tx.orderItem.updateMany.mockResolvedValue({ count: 1 });

    const result = await service.updateItemStatus(item.id, 'employee-id', {
      serveStatus: ServeStatus.READY,
    });

    expect(result.serveStatus).toBe(ServeStatus.READY);
    expect(tx.orderItem.updateMany).toHaveBeenCalledWith({
      where: expect.objectContaining({
        serveStatus: ServeStatus.COOKING,
        orderSession: { is: { sessionStatus: SessionStatus.COMPLETED } },
      }),
      data: { serveStatus: ServeStatus.READY, readyAt: expect.any(Date) },
    });
    expect(inventoryConsumption.consumeOrderItem).not.toHaveBeenCalled();
    expect(outbox.enqueue).toHaveBeenCalledTimes(1);
  });

  it('keeps the direct cooking-to-served path for dine-in orders', async () => {
    const item = {
      id: 'order-item-id',
      isPaid: false,
      invoiceId: null,
      serveStatus: ServeStatus.COOKING,
      orderSessionId: 'session-id',
      orderSession: {
        sessionStatus: SessionStatus.ACTIVE,
        tableId: 'table-id',
      },
    };
    tx.orderItem.findUnique
      .mockResolvedValueOnce(item)
      .mockResolvedValueOnce({ ...item, serveStatus: ServeStatus.SERVED });
    tx.orderItem.updateMany.mockResolvedValue({ count: 1 });

    await expect(
      service.updateItemStatus(item.id, 'employee-id', {
        serveStatus: ServeStatus.SERVED,
      }),
    ).resolves.toMatchObject({ serveStatus: ServeStatus.SERVED });
  });

  it('rejects READY for dine-in until table lifecycle supports it', async () => {
    tx.orderItem.findUnique.mockResolvedValue({
      id: 'order-item-id',
      serveStatus: ServeStatus.COOKING,
      orderSession: {
        sessionStatus: SessionStatus.ACTIVE,
        tableId: 'table-id',
      },
    });

    await expect(
      service.updateItemStatus('order-item-id', 'employee-id', {
        serveStatus: ServeStatus.READY,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(tx.orderItem.updateMany).not.toHaveBeenCalled();
  });

  it('hands off a READY takeaway item without consuming inventory again', async () => {
    const item = {
      id: 'order-item-id',
      isPaid: true,
      invoiceId: 'invoice-id',
      serveStatus: ServeStatus.READY,
      orderSessionId: 'session-id',
      orderSession: {
        sessionStatus: SessionStatus.COMPLETED,
        tableId: null,
      },
    };
    tx.orderItem.findUnique
      .mockResolvedValueOnce(item)
      .mockResolvedValueOnce({ ...item, serveStatus: ServeStatus.SERVED });
    tx.orderItem.updateMany.mockResolvedValue({ count: 1 });

    await service.handoffTakeawayItem(item.id, 'employee-id');

    expect(inventoryConsumption.consumeOrderItem).not.toHaveBeenCalled();
    expect(tx.orderItem.updateMany).toHaveBeenCalledWith({
      where: expect.objectContaining({ serveStatus: ServeStatus.READY }),
      data: { serveStatus: ServeStatus.SERVED },
    });
  });

  it('does not hand off an item that is still cooking', async () => {
    tx.orderItem.findUnique.mockResolvedValue({
      id: 'order-item-id',
      invoiceId: 'invoice-id',
      serveStatus: ServeStatus.COOKING,
      orderSession: {
        sessionStatus: SessionStatus.COMPLETED,
        tableId: null,
      },
    });

    await expect(
      service.handoffTakeawayItem('order-item-id', 'employee-id'),
    ).rejects.toThrow('Takeaway item is not ready for handoff.');
    expect(tx.orderItem.updateMany).not.toHaveBeenCalled();
  });

  it('lists only READY items for staff handoff with ticket numbers', async () => {
    const readyAt = new Date();
    prisma.orderItem.count.mockResolvedValue(1);
    prisma.orderItem.findMany.mockResolvedValue([
      {
        id: 'order-item-id',
        quantity: 2,
        readyAt,
        orderSessionId: 'session-id',
        orderSession: { table: null },
        menuItem: { name: 'Latte' },
        kitchenTicketItem: {
          ticket: { sequence: 42, station: { code: 'BAR' } },
        },
      },
    ]);

    const page = await service.getHandoffItems({
      page: 1,
      itemPerPage: 20,
    });

    expect(prisma.orderItem.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          serveStatus: ServeStatus.READY,
          orderSession: {
            is: {
              tableId: null,
              sessionStatus: { not: SessionStatus.CANCELLED },
            },
          },
        },
        take: 20,
      }),
    );
    expect(page.list[0]).toMatchObject({
      id: 'order-item-id',
      ticketNumber: 'BAR-42',
      readyAt,
    });
    expect(page.list[0]).not.toHaveProperty('kitchenTicketItem');
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
    expect(outbox.enqueue).not.toHaveBeenCalled();
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
    expect(outbox.enqueue).toHaveBeenCalledTimes(1);
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
        where: expect.objectContaining({
          id: { in: ['menu-item-id'] },
          deletedAt: null,
          isAvailable: true,
        }),
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
      }),
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(tx.orderSession.create).not.toHaveBeenCalled();
    expect(outbox.enqueue).not.toHaveBeenCalled();
  });

  it('attaches the employee open shift without accepting a client shift ID', async () => {
    cashierShiftLedger.findOpenShiftId.mockResolvedValue('shift-id');
    tx.orderSession.create.mockImplementation(({ data }: any) => ({
      id: 'session-id',
      ...data,
    }));

    await service.openSession({
      employeeId: 'employee-id',
      guestCount: 1,
    });

    expect(cashierShiftLedger.findOpenShiftId).toHaveBeenCalledWith(
      tx,
      'employee-id',
    );
    expect(tx.orderSession.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ shiftId: 'shift-id' }),
      }),
    );
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
      }),
    ).resolves.toEqual(session);

    expect(prisma.$transaction).toHaveBeenCalledTimes(2);
    expect(outbox.enqueue).toHaveBeenCalledTimes(1);
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
    expect(outbox.enqueue).toHaveBeenCalledTimes(1);
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
    expect(outbox.enqueue).not.toHaveBeenCalled();
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
    expect(outbox.enqueue).not.toHaveBeenCalled();
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
