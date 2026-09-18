import { ConflictException } from '@nestjs/common';
import { InventoryTxType, Prisma } from '@prisma/client';
import { INVENTORY_EVENTS } from '../events/inventory.events';
import { InventoryConsumptionService } from './inventory-consumption.service';

describe('InventoryConsumptionService', () => {
  let service: InventoryConsumptionService;
  let publisher: { emit: jest.Mock };
  let tx: any;

  beforeEach(() => {
    publisher = { emit: jest.fn() };
    service = new InventoryConsumptionService(publisher as never);
    tx = {
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

  it('deducts stock and snapshots the recipe using the order quantity', async () => {
    tx.menuItemIngredient.findMany.mockResolvedValue([
      {
        quantity: new Prisma.Decimal('0.25'),
        inventoryItem: {
          id: 'coffee-id',
          name: 'Coffee beans',
          deletedAt: null,
          unit: { name: 'kg' },
        },
      },
      {
        quantity: new Prisma.Decimal('0.1'),
        inventoryItem: {
          id: 'milk-id',
          name: 'Milk',
          deletedAt: null,
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
      { id: 'coffee-id', stock: new Prisma.Decimal('9.5') },
      { id: 'milk-id', stock: new Prisma.Decimal('4.8') },
    ]);

    const movements = await service.consumeOrderItem(tx as never, {
      id: 'order-item-id',
      menuItemId: 'menu-item-id',
      quantity: 2,
    });

    expect(tx.inventoryItem.updateMany).toHaveBeenNthCalledWith(1, {
      where: {
        id: 'coffee-id',
        deletedAt: null,
        stock: { gte: new Prisma.Decimal('0.5') },
      },
      data: { stock: { decrement: new Prisma.Decimal('0.5') } },
    });
    expect(tx.orderItemIngredientSnapshot.createMany).toHaveBeenCalledWith({
      data: [
        expect.objectContaining({
          orderItemId: 'order-item-id',
          inventoryItemId: 'coffee-id',
          inventoryItemName: 'Coffee beans',
          unitName: 'kg',
          totalQuantity: new Prisma.Decimal('0.5'),
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
          }),
        ]),
      }),
    );
    expect(movements).toEqual([
      expect.objectContaining({
        inventoryItemId: 'coffee-id',
        transactionId: 'coffee-tx',
        stockAfter: new Prisma.Decimal('9.5'),
      }),
      expect.objectContaining({
        inventoryItemId: 'milk-id',
        transactionId: 'milk-tx',
        stockAfter: new Prisma.Decimal('4.8'),
      }),
    ]);
  });

  it('rejects insufficient stock before writing snapshots or ledger rows', async () => {
    tx.menuItemIngredient.findMany.mockResolvedValue([
      {
        quantity: new Prisma.Decimal(1),
        inventoryItem: {
          id: 'coffee-id',
          name: 'Coffee beans',
          deletedAt: null,
          unit: { name: 'kg' },
        },
      },
    ]);
    tx.inventoryItem.updateMany.mockResolvedValue({ count: 0 });

    await expect(
      service.consumeOrderItem(tx as never, {
        id: 'order-item-id',
        menuItemId: 'menu-item-id',
        quantity: 2,
      }),
    ).rejects.toBeInstanceOf(ConflictException);

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

  it('emits stock changes only when inventory was consumed', () => {
    service.emitConsumption([]);
    expect(publisher.emit).not.toHaveBeenCalled();

    service.emitConsumption([
      {
        inventoryItemId: 'coffee-id',
        transactionId: 'transaction-id',
        type: InventoryTxType.EXPORT,
        quantity: new Prisma.Decimal('0.5'),
        stockAfter: new Prisma.Decimal('9.5'),
      },
    ]);

    expect(publisher.emit).toHaveBeenCalledWith(
      INVENTORY_EVENTS.STOCK_EXPORTED,
      expect.objectContaining({ inventoryItemIds: ['coffee-id'] }),
    );
  });
});
