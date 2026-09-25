import { randomUUID } from 'node:crypto';
import {
  PrismaClient,
  PurchaseReceiptStatus,
  StocktakeStatus,
} from '@prisma/client';
import { Decimal } from '@prisma/client/runtime/library';
import { IdempotencyService } from '../src/app/durable/idempotency.service';
import { OutboxService } from '../src/app/durable/outbox.service';
import { InventoryPolicyService } from '../src/app/inventory/policies/inventory-policy.service';
import { InventoryRepository } from '../src/app/inventory/repositories/inventory.repository';
import { InventoryAuditService } from '../src/app/inventory/services/inventory-audit.service';
import { InventoryTransactionService } from '../src/app/inventory/services/inventory-transaction.service';
import { PurchaseReceiptService } from '../src/app/inventory/services/purchase-receipt.service';
import { StocktakeService } from '../src/app/inventory/services/stocktake.service';

describe('Inventory procurement and stocktake (e2e)', () => {
  const prisma = new PrismaClient();
  const repository = new InventoryRepository(prisma as never);
  const policy = new InventoryPolicyService();
  const transaction = new InventoryTransactionService(repository);
  const audit = new InventoryAuditService();
  const idempotency = new IdempotencyService(prisma as never);
  const outbox = new OutboxService();
  const purchaseReceipts = new PurchaseReceiptService(
    repository,
    policy,
    transaction,
    audit,
    idempotency,
    outbox,
    {} as never,
  );
  const stocktakes = new StocktakeService(
    repository,
    policy,
    transaction,
    audit,
    idempotency,
    outbox,
    {} as never,
  );
  const suffix = randomUUID();

  let positionId: string;
  let employeeId: string;
  let categoryId: string;
  let unitId: string;
  let inventoryItemId: string;
  let supplierId: string;
  let receiptId: string;
  let stocktakeId: string;

  beforeAll(async () => {
    const position = await prisma.position.create({
      data: { name: `Procurement Position ${suffix}`, salary: 0 },
    });
    positionId = position.id;
    const employee = await prisma.employee.create({
      data: {
        email: `procurement-${suffix}@example.com`,
        username: `procurement-${suffix}`,
        fullName: 'Procurement Test Employee',
        password: 'not-used-in-procurement-tests',
        positionId,
      },
    });
    employeeId = employee.id;
    const category = await prisma.inventoryCategory.create({
      data: { name: `Procurement Category ${suffix}` },
    });
    categoryId = category.id;
    const unit = await prisma.unit.create({
      data: { name: `Procurement Unit ${suffix}` },
    });
    unitId = unit.id;
    const item = await prisma.inventoryItem.create({
      data: {
        name: `Procurement Item ${suffix}`,
        stock: 10,
        averageUnitCost: 20_000,
        categoryId,
        unitId,
      },
    });
    inventoryItemId = item.id;
    const supplier = await prisma.supplier.create({
      data: { code: `SUP-${suffix}`, name: `Supplier ${suffix}` },
    });
    supplierId = supplier.id;
  });

  afterAll(async () => {
    try {
      await prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(
          "SET LOCAL app.allow_audit_log_mutation = 'on'",
        );
        await tx.actionLog.deleteMany({ where: { employeeId } });
      });
      const documentIds = [receiptId, stocktakeId].filter((id): id is string =>
        Boolean(id),
      );
      if (documentIds.length > 0) {
        await prisma.outboxEvent.deleteMany({
          where: { aggregateId: { in: documentIds } },
        });
      }
      await prisma.idempotencyRequest.deleteMany({ where: { employeeId } });
      if (receiptId) {
        await prisma.inventoryTransaction.deleteMany({
          where: { purchaseReceiptItem: { purchaseReceiptId: receiptId } },
        });
        await prisma.purchaseReceipt.deleteMany({ where: { id: receiptId } });
      }
      if (stocktakeId) {
        await prisma.inventoryTransaction.deleteMany({
          where: { stocktakeItem: { stocktakeId } },
        });
        await prisma.stocktake.deleteMany({ where: { id: stocktakeId } });
      }
      await prisma.supplier.deleteMany({ where: { id: supplierId } });
      await prisma.inventoryItem.deleteMany({ where: { id: inventoryItemId } });
      await prisma.inventoryCategory.deleteMany({ where: { id: categoryId } });
      await prisma.unit.deleteMany({ where: { id: unitId } });
      await prisma.employee.deleteMany({ where: { id: employeeId } });
      await prisma.position.deleteMany({ where: { id: positionId } });
    } finally {
      await prisma.$disconnect();
    }
  });

  it('posts a receipt exactly once under concurrent requests', async () => {
    const receipt = await purchaseReceipts.create(employeeId, {
      supplierId,
      receivedAt: undefined,
      note: null,
      idempotencyKey: `create-${suffix}`,
      items: [{ inventoryItemId, quantity: 5, unitPrice: 23_000 }],
    });
    receiptId = receipt.id;

    const results = await Promise.allSettled([
      purchaseReceipts.post(receiptId, employeeId, {
        idempotencyKey: `post-a-${suffix}`,
      }),
      purchaseReceipts.post(receiptId, employeeId, {
        idempotencyKey: `post-b-${suffix}`,
      }),
    ]);
    expect(results.filter(({ status }) => status === 'fulfilled')).toHaveLength(
      1,
    );

    const [item, persistedReceipt, transactions] = await Promise.all([
      prisma.inventoryItem.findUniqueOrThrow({
        where: { id: inventoryItemId },
      }),
      prisma.purchaseReceipt.findUniqueOrThrow({ where: { id: receiptId } }),
      prisma.inventoryTransaction.findMany({
        where: { purchaseReceiptItem: { purchaseReceiptId: receiptId } },
      }),
    ]);
    expect(persistedReceipt.status).toBe(PurchaseReceiptStatus.POSTED);
    expect(item.stock).toEqual(new Decimal(15));
    expect(item.averageUnitCost).toEqual(new Decimal(21_000));
    expect(transactions).toHaveLength(1);
    expect(transactions[0]?.totalAmount).toEqual(new Decimal(115_000));
  });

  it('keeps a stocktake draft when stock changed after its snapshot', async () => {
    const stocktake = await stocktakes.create(employeeId, {
      inventoryItemIds: [inventoryItemId],
      note: null,
      idempotencyKey: `stocktake-create-${suffix}`,
    });
    stocktakeId = stocktake.id;
    await stocktakes.updateCounts(stocktakeId, employeeId, {
      items: [{ inventoryItemId, countedQuantity: 15 }],
    });
    await prisma.inventoryItem.update({
      where: { id: inventoryItemId },
      data: { stock: { increment: 1 } },
    });

    await expect(
      stocktakes.post(stocktakeId, employeeId, {
        idempotencyKey: `stocktake-post-${suffix}`,
      }),
    ).rejects.toBeDefined();

    const persisted = await prisma.stocktake.findUniqueOrThrow({
      where: { id: stocktakeId },
    });
    expect(persisted.status).toBe(StocktakeStatus.DRAFT);
    expect(
      await prisma.inventoryTransaction.count({
        where: { stocktakeItem: { stocktakeId } },
      }),
    ).toBe(0);
  });
});
