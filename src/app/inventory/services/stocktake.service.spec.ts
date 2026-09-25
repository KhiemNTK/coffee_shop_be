import { ConflictException } from '@nestjs/common';
import { InventoryTxType, StocktakeStatus } from '@prisma/client';
import { Decimal } from '@prisma/client/runtime/library';
import { InventoryPolicyService } from '../policies/inventory-policy.service';
import { StocktakeService } from './stocktake.service';

describe('StocktakeService', () => {
  let service: StocktakeService;
  let tx: any;
  let outbox: { enqueue: jest.Mock };

  beforeEach(() => {
    tx = {
      employee: { findFirst: jest.fn().mockResolvedValue({ isActive: true }) },
      stocktake: {
        create: jest.fn(),
        findUnique: jest.fn(),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      stocktakeItem: { update: jest.fn() },
      inventoryItem: {
        findMany: jest.fn(),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      inventoryTransaction: {
        createManyAndReturn: jest
          .fn()
          .mockResolvedValue([
            { id: 'transaction-id', stocktakeItemId: 'line-id' },
          ]),
      },
    };
    outbox = { enqueue: jest.fn() };
    service = new StocktakeService(
      {} as never,
      new InventoryPolicyService(),
      {} as never,
      { log: jest.fn() },
      { execute: jest.fn((_input, operation) => operation(tx)) } as never,
      outbox as never,
      {} as never,
    );
  });

  it('captures the expected stock when a stocktake is created', async () => {
    tx.inventoryItem.findMany.mockResolvedValue([
      {
        id: 'item-id',
        name: 'Arabica beans',
        stock: new Decimal(12.5),
        unit: { name: 'kg' },
      },
    ]);
    tx.stocktake.create.mockImplementation(({ data }) => ({
      id: 'stocktake-id',
      stocktakeNumber: data.stocktakeNumber,
    }));

    await service.create('employee-id', {
      inventoryItemIds: ['item-id'],
      note: null,
      idempotencyKey: 'stocktake-create-key',
    });

    expect(tx.stocktake.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        items: {
          create: [
            {
              inventoryItemId: 'item-id',
              inventoryItemName: 'Arabica beans',
              unitName: 'kg',
              expectedQuantity: new Decimal(12.5),
            },
          ],
        },
      }),
      include: expect.any(Object),
    });
  });

  it('posts a negative variance with an immutable cost snapshot', async () => {
    tx.stocktake.findUnique.mockResolvedValue({
      id: 'stocktake-id',
      stocktakeNumber: 'ST-1',
      status: StocktakeStatus.DRAFT,
      items: [
        {
          id: 'line-id',
          expectedQuantity: new Decimal(10),
          countedQuantity: new Decimal(8),
          inventoryItem: {
            id: 'item-id',
            deletedAt: null,
            stock: new Decimal(10),
            averageUnitCost: new Decimal(20_000),
          },
        },
      ],
    });

    const result = await service.post('stocktake-id', 'employee-id', {
      idempotencyKey: 'stocktake-post-key',
    });

    expect(tx.inventoryItem.updateMany).toHaveBeenCalledWith({
      where: {
        id: 'item-id',
        deletedAt: null,
        stock: new Decimal(10),
      },
      data: { stock: new Decimal(8) },
    });
    expect(tx.inventoryTransaction.createManyAndReturn).toHaveBeenCalledWith({
      data: [
        expect.objectContaining({
          stocktakeItemId: 'line-id',
          type: InventoryTxType.EXPORT,
          quantity: new Decimal(2),
          unitPrice: new Decimal(20_000),
          totalAmount: new Decimal(40_000),
        }),
      ],
      select: { id: true, stocktakeItemId: true },
    });
    expect(tx.stocktakeItem.update).toHaveBeenCalledWith({
      where: { id: 'line-id' },
      data: { differenceQuantity: new Decimal(-2) },
    });
    expect(result).toEqual(
      expect.objectContaining({ status: StocktakeStatus.POSTED }),
    );
    expect(outbox.enqueue).toHaveBeenCalledTimes(1);
  });

  it('requires a recount when stock changed after the snapshot', async () => {
    tx.stocktake.findUnique.mockResolvedValue({
      id: 'stocktake-id',
      stocktakeNumber: 'ST-1',
      status: StocktakeStatus.DRAFT,
      items: [
        {
          id: 'line-id',
          expectedQuantity: new Decimal(10),
          countedQuantity: new Decimal(8),
          inventoryItem: {
            id: 'item-id',
            deletedAt: null,
            stock: new Decimal(11),
            averageUnitCost: new Decimal(20_000),
          },
        },
      ],
    });

    await expect(
      service.post('stocktake-id', 'employee-id', {
        idempotencyKey: 'stocktake-post-key',
      }),
    ).rejects.toBeInstanceOf(ConflictException);

    expect(tx.inventoryItem.updateMany).not.toHaveBeenCalled();
    expect(tx.inventoryTransaction.createManyAndReturn).not.toHaveBeenCalled();
  });

  it('conditionally touches unchanged stock without creating a ledger row', async () => {
    tx.stocktake.findUnique.mockResolvedValue({
      id: 'stocktake-id',
      stocktakeNumber: 'ST-1',
      status: StocktakeStatus.DRAFT,
      items: [
        {
          id: 'line-id',
          expectedQuantity: new Decimal(10),
          countedQuantity: new Decimal(10),
          inventoryItem: {
            id: 'item-id',
            deletedAt: null,
            stock: new Decimal(10),
            averageUnitCost: new Decimal(20_000),
          },
        },
      ],
    });

    await service.post('stocktake-id', 'employee-id', {
      idempotencyKey: 'stocktake-post-key',
    });

    expect(tx.inventoryItem.updateMany).toHaveBeenCalledWith({
      where: {
        id: 'item-id',
        deletedAt: null,
        stock: new Decimal(10),
      },
      data: { stock: new Decimal(10) },
    });
    expect(tx.inventoryTransaction.createManyAndReturn).not.toHaveBeenCalled();
    expect(tx.stocktakeItem.update).toHaveBeenCalledWith({
      where: { id: 'line-id' },
      data: { differenceQuantity: new Decimal(0) },
    });
  });

  it('requires a recount when stock changes during posting', async () => {
    tx.stocktake.findUnique.mockResolvedValue({
      id: 'stocktake-id',
      stocktakeNumber: 'ST-1',
      status: StocktakeStatus.DRAFT,
      items: [
        {
          id: 'line-id',
          expectedQuantity: new Decimal(10),
          countedQuantity: new Decimal(10),
          inventoryItem: {
            id: 'item-id',
            deletedAt: null,
            stock: new Decimal(10),
            averageUnitCost: new Decimal(20_000),
          },
        },
      ],
    });
    tx.inventoryItem.updateMany.mockResolvedValue({ count: 0 });

    await expect(
      service.post('stocktake-id', 'employee-id', {
        idempotencyKey: 'stocktake-post-key',
      }),
    ).rejects.toBeInstanceOf(ConflictException);

    expect(tx.inventoryTransaction.createManyAndReturn).not.toHaveBeenCalled();
    expect(tx.stocktakeItem.update).not.toHaveBeenCalled();
    expect(outbox.enqueue).not.toHaveBeenCalled();
  });
});
