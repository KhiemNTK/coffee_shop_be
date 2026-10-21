import { BadRequestException } from '@nestjs/common';
import { InventoryTxType } from '@prisma/client';
import { Decimal } from '@prisma/client/runtime/library';
import { InventoryPolicyService } from '../policies/inventory-policy.service';
import { InventoryMovementService } from './inventory-movement.service';

describe('InventoryMovementService', () => {
  let service: InventoryMovementService;
  let tx: any;
  let repository: { ensureActiveItemExists: jest.Mock };
  let outbox: { enqueue: jest.Mock };
  let idempotency: { execute: jest.Mock };

  beforeEach(() => {
    tx = {
      employee: { findFirst: jest.fn().mockResolvedValue({ isActive: true }) },
      inventoryItem: {
        update: jest.fn(),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        findFirst: jest.fn(),
      },
      inventoryTransaction: {
        create: jest.fn().mockResolvedValue({ id: 'transaction-id' }),
      },
    };
    repository = {
      ensureActiveItemExists: jest.fn().mockResolvedValue({
        id: 'item-id',
        stock: new Decimal(10),
        reservedStock: new Decimal(0),
        averageUnitCost: new Decimal(20_000),
      }),
    };
    outbox = { enqueue: jest.fn() };
    idempotency = { execute: jest.fn((_input, operation) => operation(tx)) };
    service = new InventoryMovementService(
      repository as never,
      new InventoryPolicyService(),
      { log: jest.fn() },
      idempotency as never,
      outbox as never,
    );
  });

  it('updates weighted-average cost for a manual import', async () => {
    tx.inventoryItem.findFirst.mockResolvedValue({
      stock: new Decimal(15),
      averageUnitCost: new Decimal(21_000),
    });

    const result = await service.importItem('item-id', 'employee-id', {
      quantity: 5,
      idempotencyKey: 'import-key-1',
      unitPrice: 23_000,
      note: 'Opening balance correction',
      transactionDate: undefined,
    });

    expect(tx.inventoryItem.update).toHaveBeenCalledWith({
      where: { id: 'item-id' },
      data: {
        stock: { increment: new Decimal(5) },
        averageUnitCost: new Decimal(21_000),
      },
    });
    expect(tx.inventoryTransaction.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        type: InventoryTxType.IMPORT,
        unitPrice: new Decimal(23_000),
        totalAmount: new Decimal(115_000),
      }),
      select: { id: true },
    });
    expect(result).toEqual(
      expect.objectContaining({
        stockAfter: new Decimal(15),
        averageUnitCost: new Decimal(21_000),
      }),
    );
    expect(outbox.enqueue).toHaveBeenCalledTimes(1);
    expect(idempotency.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        employeeId: 'employee-id',
        operation: 'inventory.stock.import',
        key: 'import-key-1',
      }),
      expect.any(Function),
    );
  });

  it('snapshots current cost for a manual export', async () => {
    tx.inventoryItem.findFirst.mockResolvedValue({
      stock: new Decimal(8),
      averageUnitCost: new Decimal(20_000),
    });

    await service.exportItem('item-id', 'employee-id', {
      quantity: 2,
      idempotencyKey: 'export-key-1',
      note: 'Damaged stock correction',
      transactionDate: undefined,
    });

    expect(tx.inventoryItem.updateMany).toHaveBeenCalledWith({
      where: {
        id: 'item-id',
        stock: { gte: new Decimal(2) },
        reservedStock: new Decimal(0),
      },
      data: { stock: { decrement: new Decimal(2) } },
    });
    expect(tx.inventoryTransaction.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        type: InventoryTxType.EXPORT,
        unitPrice: new Decimal(20_000),
        totalAmount: new Decimal(40_000),
      }),
      select: { id: true },
    });
  });

  it('rejects an internal import without a unit price', async () => {
    await expect(
      service.importItem('item-id', 'employee-id', {
        quantity: 1,
        idempotencyKey: 'import-key-2',
        note: 'Cost correction',
      } as never),
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(tx.inventoryItem.update).not.toHaveBeenCalled();
    expect(tx.inventoryTransaction.create).not.toHaveBeenCalled();
  });

  it('rejects an internal movement without a key before touching stock', async () => {
    await expect(
      service.exportItem('item-id', 'employee-id', {
        quantity: 1,
        note: 'Stock correction',
      } as never),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(idempotency.execute).not.toHaveBeenCalled();
    expect(tx.inventoryTransaction.create).not.toHaveBeenCalled();
  });
});
