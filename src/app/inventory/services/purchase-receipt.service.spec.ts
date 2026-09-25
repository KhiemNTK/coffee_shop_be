import { ConflictException } from '@nestjs/common';
import { InventoryTxType, PurchaseReceiptStatus } from '@prisma/client';
import { Decimal } from '@prisma/client/runtime/library';
import { InventoryPolicyService } from '../policies/inventory-policy.service';
import { PurchaseReceiptService } from './purchase-receipt.service';

describe('PurchaseReceiptService', () => {
  let service: PurchaseReceiptService;
  let tx: any;
  let audit: { log: jest.Mock };
  let outbox: { enqueue: jest.Mock };
  let idempotency: { execute: jest.Mock };

  beforeEach(() => {
    tx = {
      employee: { findFirst: jest.fn().mockResolvedValue({ isActive: true }) },
      purchaseReceipt: {
        create: jest.fn(),
        findUnique: jest.fn(),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      supplier: {
        findFirst: jest.fn().mockResolvedValue({ id: 'supplier-id' }),
      },
      inventoryItem: {
        findMany: jest.fn(),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      inventoryTransaction: {
        createManyAndReturn: jest.fn().mockResolvedValue([
          {
            id: 'transaction-id',
            purchaseReceiptItemId: 'line-id',
          },
        ]),
      },
    };
    audit = { log: jest.fn() };
    outbox = { enqueue: jest.fn() };
    idempotency = {
      execute: jest.fn((_input, operation) => operation(tx)),
    };
    service = new PurchaseReceiptService(
      {} as never,
      new InventoryPolicyService(),
      {} as never,
      audit,
      idempotency as never,
      outbox as never,
      {} as never,
    );
  });

  it('creates immutable line snapshots and computes totals server-side', async () => {
    tx.inventoryItem.findMany.mockResolvedValue([
      {
        id: 'item-id',
        name: 'Arabica beans',
        unit: { name: 'kg' },
      },
    ]);
    tx.purchaseReceipt.create.mockImplementation(({ data }) => ({
      id: 'receipt-id',
      receiptNumber: data.receiptNumber,
      supplierId: data.supplierId,
      totalAmount: data.totalAmount,
    }));

    const result = await service.create('employee-id', {
      supplierId: 'supplier-id',
      receivedAt: undefined,
      note: null,
      idempotencyKey: 'receipt-create-key',
      items: [{ inventoryItemId: 'item-id', quantity: 5, unitPrice: 23_000 }],
    });

    expect(tx.purchaseReceipt.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        supplierId: 'supplier-id',
        totalAmount: new Decimal(115_000),
        items: {
          create: [
            {
              inventoryItemId: 'item-id',
              inventoryItemName: 'Arabica beans',
              unitName: 'kg',
              quantity: new Decimal(5),
              unitPrice: new Decimal(23_000),
              totalAmount: new Decimal(115_000),
            },
          ],
        },
      }),
      include: expect.any(Object),
    });
    expect(result.totalAmount).toEqual(new Decimal(115_000));
  });

  it('posts a receipt and updates weighted-average cost atomically', async () => {
    tx.purchaseReceipt.findUnique.mockResolvedValue({
      id: 'receipt-id',
      receiptNumber: 'PR-1',
      status: PurchaseReceiptStatus.DRAFT,
      receivedAt: new Date('2026-09-23T00:00:00.000Z'),
      supplier: { deletedAt: null },
      items: [
        {
          id: 'line-id',
          quantity: new Decimal(5),
          unitPrice: new Decimal(23_000),
          totalAmount: new Decimal(115_000),
          inventoryItem: {
            id: 'item-id',
            deletedAt: null,
            stock: new Decimal(10),
            averageUnitCost: new Decimal(20_000),
          },
        },
      ],
    });

    const result = await service.post('receipt-id', 'employee-id', {
      idempotencyKey: 'receipt-post-key',
    });

    expect(tx.inventoryItem.updateMany).toHaveBeenCalledWith({
      where: {
        id: 'item-id',
        deletedAt: null,
        stock: new Decimal(10),
        averageUnitCost: new Decimal(20_000),
      },
      data: {
        stock: new Decimal(15),
        averageUnitCost: new Decimal(21_000),
      },
    });
    expect(tx.inventoryTransaction.createManyAndReturn).toHaveBeenCalledWith({
      data: [
        expect.objectContaining({
          purchaseReceiptItemId: 'line-id',
          type: InventoryTxType.IMPORT,
          unitPrice: new Decimal(23_000),
          totalAmount: new Decimal(115_000),
        }),
      ],
      select: { id: true, purchaseReceiptItemId: true },
    });
    expect(result).toEqual(
      expect.objectContaining({ status: PurchaseReceiptStatus.POSTED }),
    );
    expect(audit.log).toHaveBeenCalledTimes(1);
    expect(outbox.enqueue).toHaveBeenCalledTimes(1);
  });

  it('rolls back when an inventory row changes during posting', async () => {
    tx.purchaseReceipt.findUnique.mockResolvedValue({
      id: 'receipt-id',
      receiptNumber: 'PR-1',
      status: PurchaseReceiptStatus.DRAFT,
      receivedAt: new Date(),
      supplier: { deletedAt: null },
      items: [
        {
          id: 'line-id',
          quantity: new Decimal(1),
          unitPrice: new Decimal(10),
          totalAmount: new Decimal(10),
          inventoryItem: {
            id: 'item-id',
            deletedAt: null,
            stock: new Decimal(1),
            averageUnitCost: new Decimal(10),
          },
        },
      ],
    });
    tx.inventoryItem.updateMany.mockResolvedValue({ count: 0 });

    await expect(
      service.post('receipt-id', 'employee-id', {
        idempotencyKey: 'receipt-post-key',
      }),
    ).rejects.toBeInstanceOf(ConflictException);

    expect(tx.inventoryTransaction.createManyAndReturn).not.toHaveBeenCalled();
    expect(outbox.enqueue).not.toHaveBeenCalled();
  });
});
