import { InventoryTxType, Prisma } from '@prisma/client';
import { InventoryConsumptionService } from './inventory-consumption.service';

describe('InventoryConsumptionService', () => {
  let service: InventoryConsumptionService;
  let outbox: { enqueue: jest.Mock };
  let tx: any;

  beforeEach(() => {
    outbox = { enqueue: jest.fn() };
    service = new InventoryConsumptionService(outbox as never);
    tx = {
      $executeRaw: jest.fn().mockResolvedValue(1),
      inventoryReservation: {
        findMany: jest.fn().mockResolvedValue([]),
        deleteMany: jest.fn(),
        createMany: jest.fn(),
      },
      orderItem: {
        findMany: jest.fn().mockResolvedValue([]),
        updateMany: jest.fn(),
      },
      orderItemRecipeIngredient: { findMany: jest.fn(), createMany: jest.fn() },
      menuItemIngredient: { findMany: jest.fn() },
      inventoryItem: {
        updateMany: jest.fn(),
        findMany: jest.fn(),
      },
      orderItemIngredientSnapshot: {
        createMany: jest.fn(),
        findMany: jest.fn(),
      },
      inventoryTransaction: { createManyAndReturn: jest.fn() },
      inventoryWaste: { createManyAndReturn: jest.fn() },
    };
  });

  it('reserves each ingredient once in ID order and totals quantities across order items', async () => {
    tx.orderItem.findMany.mockResolvedValue([
      {
        id: 'item-a',
        quantity: 3,
        recipeSnapshottedAt: new Date(),
        inventoryReservations: [],
        recipeIngredients: [
          {
            inventoryItemId: 'z',
            quantityPerItem: new Prisma.Decimal('0.1234'),
          },
          { inventoryItemId: 'a', quantityPerItem: new Prisma.Decimal('0.25') },
        ],
      },
      {
        id: 'item-b',
        quantity: 2,
        recipeSnapshottedAt: new Date(),
        inventoryReservations: [],
        recipeIngredients: [
          {
            inventoryItemId: 'z',
            quantityPerItem: new Prisma.Decimal('0.0001'),
          },
        ],
      },
    ]);

    await service.reserveSession(tx as never, 'session-id');

    expect(tx.orderItem.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          AND: [{ orderSessionId: 'session-id' }, { serveStatus: 'PENDING' }],
        },
      }),
    );
    expect(
      tx.$executeRaw.mock.calls.map(([, quantity, id]) => [
        id,
        quantity.toFixed(4),
      ]),
    ).toEqual([
      ['a', '0.7500'],
      ['z', '0.3704'],
    ]);
    expect(tx.inventoryReservation.createMany).toHaveBeenCalledWith({
      data: [
        {
          orderItemId: 'item-a',
          inventoryItemId: 'z',
          quantity: new Prisma.Decimal('0.3702'),
        },
        {
          orderItemId: 'item-a',
          inventoryItemId: 'a',
          quantity: new Prisma.Decimal('0.75'),
        },
        {
          orderItemId: 'item-b',
          inventoryItemId: 'z',
          quantity: new Prisma.Decimal('0.0002'),
        },
      ],
    });
  });

  it('does not hold stock twice for an already reserved invoice line', async () => {
    tx.orderItem.findMany.mockResolvedValue([
      {
        id: 'line',
        quantity: 2,
        recipeSnapshottedAt: new Date(),
        recipeIngredients: [
          {
            inventoryItemId: 'milk',
            quantityPerItem: new Prisma.Decimal('0.25'),
          },
        ],
        inventoryReservations: [
          { inventoryItemId: 'milk', quantity: new Prisma.Decimal('0.5') },
        ],
      },
    ]);
    await service.reservePendingItems(tx as never, { invoiceId: 'invoice-id' });
    expect(tx.$executeRaw).not.toHaveBeenCalled();
    expect(tx.inventoryReservation.createMany).not.toHaveBeenCalled();
  });

  it('rejects a partial or changed reservation instead of holding the remainder silently', async () => {
    tx.orderItem.findMany.mockResolvedValue([
      {
        id: 'line',
        quantity: 2,
        recipeSnapshottedAt: new Date(),
        recipeIngredients: [
          {
            inventoryItemId: 'milk',
            quantityPerItem: new Prisma.Decimal('0.25'),
          },
        ],
        inventoryReservations: [
          { inventoryItemId: 'milk', quantity: new Prisma.Decimal('0.25') },
        ],
      },
    ]);
    await expect(
      service.reservePendingItems(tx as never, { invoiceId: 'invoice-id' }),
    ).rejects.toThrow('Reserved ingredients no longer match');
    expect(tx.$executeRaw).not.toHaveBeenCalled();
  });

  it('snapshots legacy recipes before taking a payment commitment', async () => {
    tx.orderItem.findMany.mockResolvedValue([
      {
        id: 'legacy-line',
        menuItemId: 'menu',
        quantity: 2,
        recipeSnapshottedAt: null,
        recipeIngredients: [],
        inventoryReservations: [],
      },
    ]);
    tx.menuItemIngredient.findMany.mockResolvedValue([
      {
        menuItemId: 'menu',
        inventoryItemId: 'milk',
        quantity: new Prisma.Decimal('0.25'),
      },
    ]);
    await service.reservePendingItems(tx as never, { invoiceId: 'invoice-id' });
    expect(tx.orderItemRecipeIngredient.createMany).toHaveBeenCalledWith({
      data: [
        {
          orderItemId: 'legacy-line',
          inventoryItemId: 'milk',
          quantityPerItem: new Prisma.Decimal('0.25'),
        },
      ],
    });
    expect(tx.orderItem.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ['legacy-line'] }, recipeSnapshottedAt: null },
      data: { recipeSnapshottedAt: expect.any(Date) },
    });
    expect(tx.inventoryReservation.createMany).toHaveBeenCalledWith({
      data: [
        {
          orderItemId: 'legacy-line',
          inventoryItemId: 'milk',
          quantity: new Prisma.Decimal('0.5'),
        },
      ],
    });
  });

  it('rejects an insufficient reservation before creating reservation rows', async () => {
    tx.orderItem.findMany.mockResolvedValue([
      {
        id: 'line',
        quantity: 1,
        recipeSnapshottedAt: new Date(),
        inventoryReservations: [],
        recipeIngredients: [
          {
            inventoryItemId: 'milk',
            quantityPerItem: new Prisma.Decimal('0.6'),
          },
        ],
      },
    ]);
    tx.$executeRaw.mockResolvedValue(0);
    await expect(
      service.reservePendingItems(tx as never, { invoiceId: 'invoice-id' }),
    ).rejects.toMatchObject({
      response: { code: 'INVENTORY_INSUFFICIENT_STOCK' },
    });
    expect(tx.inventoryReservation.createMany).not.toHaveBeenCalled();
  });

  it('releases combined quantities in the same ID order before removing reservations', async () => {
    tx.inventoryReservation.findMany.mockResolvedValue([
      { inventoryItemId: 'z', quantity: new Prisma.Decimal('0.1234') },
      { inventoryItemId: 'a', quantity: new Prisma.Decimal('0.25') },
      { inventoryItemId: 'z', quantity: new Prisma.Decimal('0.0001') },
    ]);

    await service.releaseReservations(tx as never, ['item-a', 'item-b']);

    expect(tx.inventoryReservation.findMany).toHaveBeenCalledWith({
      where: { orderItemId: { in: ['item-a', 'item-b'] } },
      select: { inventoryItemId: true, quantity: true },
    });
    expect(
      tx.$executeRaw.mock.calls.map(([, quantity, id]) => [
        id,
        quantity.toFixed(4),
      ]),
    ).toEqual([
      ['a', '0.2500'],
      ['z', '0.1235'],
    ]);
    expect(tx.inventoryReservation.deleteMany).toHaveBeenCalledWith({
      where: { orderItemId: { in: ['item-a', 'item-b'] } },
    });
    expect(
      tx.inventoryReservation.deleteMany.mock.invocationCallOrder[0],
    ).toBeGreaterThan(
      (tx.$executeRaw as jest.Mock).mock.invocationCallOrder[1],
    );
  });

  it('does not remove reservation rows if a release update detects a conflict', async () => {
    tx.inventoryReservation.findMany.mockResolvedValue([
      { inventoryItemId: 'a', quantity: new Prisma.Decimal('0.1') },
      { inventoryItemId: 'z', quantity: new Prisma.Decimal('0.2') },
    ]);
    tx.$executeRaw.mockResolvedValueOnce(0);
    await expect(
      service.releaseReservations(tx as never, ['item-a']),
    ).rejects.toThrow('Inventory reservation state changed.');
    expect(tx.$executeRaw).toHaveBeenCalledTimes(1);
    expect(tx.inventoryReservation.deleteMany).not.toHaveBeenCalled();
  });

  it('deducts stock and snapshots the recipe using the order quantity', async () => {
    tx.menuItemIngredient.findMany.mockResolvedValue([
      {
        quantity: new Prisma.Decimal('0.25'),
        inventoryItem: {
          id: 'coffee-id',
          name: 'Coffee beans',
          deletedAt: null,
          averageUnitCost: new Prisma.Decimal('200000'),
          unit: { name: 'kg' },
        },
      },
      {
        quantity: new Prisma.Decimal('0.1'),
        inventoryItem: {
          id: 'milk-id',
          name: 'Milk',
          deletedAt: null,
          averageUnitCost: new Prisma.Decimal('30000'),
          unit: { name: 'l' },
        },
      },
    ]);
    tx.inventoryItem.updateMany.mockResolvedValue({ count: 1 });
    tx.inventoryTransaction.createManyAndReturn.mockResolvedValue([
      { id: 'coffee-tx', inventoryItemId: 'coffee-id' },
      { id: 'milk-tx', inventoryItemId: 'milk-id' },
    ]);
    tx.inventoryItem.findMany.mockResolvedValue([
      {
        id: 'coffee-id',
        stock: new Prisma.Decimal('9.5'),
        averageUnitCost: new Prisma.Decimal('200000'),
      },
      {
        id: 'milk-id',
        stock: new Prisma.Decimal('4.8'),
        averageUnitCost: new Prisma.Decimal('30000'),
      },
    ]);

    const movements = await service.consumeOrderItem(tx as never, {
      id: 'order-item-id',
      menuItemId: 'menu-item-id',
      quantity: 2,
    });

    expect(tx.$executeRaw.mock.calls[0].slice(1)).toEqual([
      new Prisma.Decimal('0.5'),
      new Prisma.Decimal(0),
      'coffee-id',
      new Prisma.Decimal(0),
      new Prisma.Decimal('0.5'),
    ]);
    expect(tx.orderItemIngredientSnapshot.createMany).toHaveBeenCalledWith({
      data: [
        expect.objectContaining({
          orderItemId: 'order-item-id',
          inventoryItemId: 'coffee-id',
          inventoryItemName: 'Coffee beans',
          unitName: 'kg',
          totalQuantity: new Prisma.Decimal('0.5'),
          unitCost: new Prisma.Decimal('200000'),
          totalCost: new Prisma.Decimal('100000'),
        }),
        expect.objectContaining({
          orderItemId: 'order-item-id',
          inventoryItemId: 'milk-id',
          totalQuantity: new Prisma.Decimal('0.2'),
        }),
      ],
    });
    expect(tx.inventoryTransaction.createManyAndReturn).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.arrayContaining([
          expect.objectContaining({
            orderItemId: 'order-item-id',
            inventoryItemId: 'coffee-id',
            type: InventoryTxType.EXPORT,
            quantity: new Prisma.Decimal('0.5'),
            unitPrice: new Prisma.Decimal('200000'),
            totalAmount: new Prisma.Decimal('100000'),
          }),
        ]),
      }),
    );
    expect(movements).toEqual([
      expect.objectContaining({
        inventoryItemId: 'coffee-id',
        transactionId: 'coffee-tx',
        unitCost: new Prisma.Decimal('200000'),
        totalAmount: new Prisma.Decimal('100000'),
        stockAfter: new Prisma.Decimal('9.5'),
      }),
      expect.objectContaining({
        inventoryItemId: 'milk-id',
        transactionId: 'milk-tx',
        stockAfter: new Prisma.Decimal('4.8'),
      }),
    ]);
    expect(outbox.enqueue).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({
        eventName: 'inventory.stock.exported',
        aggregateId: 'order-item-id',
      }),
    );
  });

  it('rejects insufficient stock before writing snapshots or ledger rows', async () => {
    tx.menuItemIngredient.findMany.mockResolvedValue([
      {
        quantity: new Prisma.Decimal(1),
        inventoryItem: {
          id: 'coffee-id',
          name: 'Coffee beans',
          deletedAt: null,
          averageUnitCost: new Prisma.Decimal('200000'),
          unit: { name: 'kg' },
        },
      },
    ]);
    tx.$executeRaw.mockResolvedValue(0);

    await expect(
      service.consumeOrderItem(tx as never, {
        id: 'order-item-id',
        menuItemId: 'menu-item-id',
        quantity: 2,
      }),
    ).rejects.toMatchObject({
      response: expect.objectContaining({
        code: 'INVENTORY_INSUFFICIENT_STOCK',
      }),
    });

    expect(tx.orderItemIngredientSnapshot.createMany).not.toHaveBeenCalled();
    expect(tx.inventoryTransaction.createManyAndReturn).not.toHaveBeenCalled();
  });

  it('records waste from the immutable consumption snapshot', async () => {
    tx.orderItemIngredientSnapshot.findMany.mockResolvedValue([
      {
        inventoryItemId: 'coffee-id',
        totalQuantity: new Prisma.Decimal('0.5'),
      },
    ]);
    tx.inventoryWaste.createManyAndReturn.mockResolvedValue([
      {
        id: 'waste-id',
        inventoryItemId: 'coffee-id',
        quantity: new Prisma.Decimal('0.5'),
      },
    ]);

    const result = await service.recordWaste(tx as never, {
      orderItemId: 'order-item-id',
      employeeId: 'employee-id',
      reason: 'Customer changed order',
    });

    expect(tx.inventoryWaste.createManyAndReturn).toHaveBeenCalledWith({
      data: [
        {
          orderItemId: 'order-item-id',
          inventoryItemId: 'coffee-id',
          quantity: new Prisma.Decimal('0.5'),
          reason: 'Customer changed order',
          employeeId: 'employee-id',
        },
      ],
      select: { id: true, inventoryItemId: true, quantity: true },
    });
    expect(result).toHaveLength(1);
  });

  it('checks combined ingredient requirements against stock minus reservations in one query', async () => {
    tx.inventoryItem.findMany.mockResolvedValue([
      {
        id: 'milk',
        stock: new Prisma.Decimal('0.5'),
        reservedStock: new Prisma.Decimal('0.2'),
      },
    ]);
    expect(
      await service.canFulfill(tx as never, [
        { inventoryItemId: 'milk', quantity: new Prisma.Decimal('0.2') },
        { inventoryItemId: 'milk', quantity: new Prisma.Decimal('0.2') },
      ]),
    ).toBe(false);
    expect(tx.inventoryItem.findMany).toHaveBeenCalledTimes(1);
    expect(
      await service.canFulfill(tx as never, [
        { inventoryItemId: 'milk', quantity: new Prisma.Decimal('0.3') },
      ]),
    ).toBe(true);
    tx.inventoryItem.findMany.mockResolvedValue([]);
    expect(
      await service.canFulfill(tx as never, [
        { inventoryItemId: 'deleted', quantity: new Prisma.Decimal(1) },
      ]),
    ).toBe(false);
  });
});
