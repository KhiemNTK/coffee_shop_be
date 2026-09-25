import { randomUUID } from 'node:crypto';
import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InventoryTxType, Prisma, PurchaseReceiptStatus } from '@prisma/client';
import { Decimal } from '@prisma/client/runtime/library';
import type {
  ExtendedPrismaTransactionClient,
  InventoryMovementResult,
} from '../../../common/types';
import { PaginationUtilService } from '../../../common/utils/pagination-util/pagination-util.service';
import { IdempotencyService } from '../../durable/idempotency.service';
import { OutboxService } from '../../durable/outbox.service';
import {
  CancelPurchaseReceiptDto,
  CreatePurchaseReceiptDto,
  GetPurchaseReceiptsDto,
  PostPurchaseReceiptDto,
  UpdatePurchaseReceiptDto,
} from '../dto';
import { INVENTORY_EVENTS } from '../events/inventory.events';
import { InventoryPolicyService } from '../policies/inventory-policy.service';
import { InventoryRepository } from '../repositories/inventory.repository';
import { InventoryAuditService } from './inventory-audit.service';
import {
  calculateInventoryValue,
  calculateWeightedAverageCost,
} from './inventory-costing';
import { InventoryTransactionService } from './inventory-transaction.service';

type ReceiptLineInput = CreatePurchaseReceiptDto['items'][number];

@Injectable()
export class PurchaseReceiptService {
  constructor(
    private readonly inventoryRepository: InventoryRepository,
    private readonly inventoryPolicy: InventoryPolicyService,
    private readonly inventoryTransaction: InventoryTransactionService,
    private readonly inventoryAudit: InventoryAuditService,
    private readonly idempotency: IdempotencyService,
    private readonly outbox: OutboxService,
    private readonly pagination: PaginationUtilService,
  ) {}

  create(employeeId: string, dto: CreatePurchaseReceiptDto) {
    const { idempotencyKey, ...request } = dto;
    return this.idempotency.execute(
      {
        employeeId,
        operation: 'inventory.purchase-receipt.create',
        key: idempotencyKey,
        request,
      },
      async (tx) => {
        await this.assertActiveEmployee(tx, employeeId);
        await this.assertActiveSupplier(tx, request.supplierId);
        const lines = await this.prepareLines(tx, request.items);
        const receipt = await tx.purchaseReceipt.create({
          data: {
            receiptNumber: this.documentNumber('PR'),
            supplierId: request.supplierId,
            createdById: employeeId,
            receivedAt: request.receivedAt,
            note: request.note,
            totalAmount: this.total(lines),
            items: { create: lines },
          },
          include: this.detailInclude,
        });
        await this.inventoryAudit.log(tx, {
          employeeId,
          actionType: 'INVENTORY_PURCHASE_RECEIPT_CREATED',
          details: {
            purchaseReceiptId: receipt.id,
            receiptNumber: receipt.receiptNumber,
            supplierId: receipt.supplierId,
            totalAmount: receipt.totalAmount.toString(),
          },
        });
        return receipt;
      },
    );
  }

  async findAll({
    page,
    itemPerPage,
    status,
    supplierId,
    receivedFrom,
    receivedTo,
  }: GetPurchaseReceiptsDto) {
    const where: Prisma.PurchaseReceiptWhereInput = {
      ...(status ? { status } : {}),
      ...(supplierId ? { supplierId } : {}),
      ...(receivedFrom || receivedTo
        ? {
            receivedAt: {
              ...(receivedFrom ? { gte: receivedFrom } : {}),
              ...(receivedTo ? { lte: receivedTo } : {}),
            },
          }
        : {}),
    };
    const totalItems =
      await this.inventoryRepository.client.purchaseReceipt.count({ where });
    const paging = this.pagination.paging({ page, itemPerPage, totalItems });
    const receipts =
      await this.inventoryRepository.client.purchaseReceipt.findMany({
        where,
        skip: paging.skip,
        take: paging.itemPerPage,
        orderBy: [{ receivedAt: 'desc' }, { id: 'desc' }],
        include: {
          supplier: { select: { id: true, code: true, name: true } },
          createdBy: { select: { id: true, fullName: true } },
          _count: { select: { items: true } },
        },
      });
    return paging.format(receipts);
  }

  async findOne(id: string) {
    const receipt =
      await this.inventoryRepository.client.purchaseReceipt.findUnique({
        where: { id },
        include: this.detailInclude,
      });
    if (!receipt) {
      throw new NotFoundException(`Purchase receipt with ID ${id} not found.`);
    }
    return receipt;
  }

  update(id: string, employeeId: string, dto: UpdatePurchaseReceiptDto) {
    return this.inventoryTransaction.runSerializable(async (tx) => {
      await this.assertActiveEmployee(tx, employeeId);
      await this.assertDraft(tx, id);
      const { items, supplierId, ...changes } = dto;
      if (supplierId) await this.assertActiveSupplier(tx, supplierId);
      const lines = items ? await this.prepareLines(tx, items) : undefined;
      if (lines) {
        await tx.purchaseReceiptItem.deleteMany({
          where: { purchaseReceiptId: id },
        });
      }
      const receipt = await tx.purchaseReceipt.update({
        where: { id },
        data: {
          ...changes,
          ...(supplierId ? { supplierId } : {}),
          ...(lines
            ? {
                totalAmount: this.total(lines),
                items: { create: lines },
              }
            : {}),
        },
        include: this.detailInclude,
      });
      await this.inventoryAudit.log(tx, {
        employeeId,
        actionType: 'INVENTORY_PURCHASE_RECEIPT_UPDATED',
        details: { purchaseReceiptId: id },
      });
      return receipt;
    });
  }

  post(
    id: string,
    employeeId: string,
    { idempotencyKey }: PostPurchaseReceiptDto,
  ) {
    return this.idempotency.execute(
      {
        employeeId,
        operation: 'inventory.purchase-receipt.post',
        key: idempotencyKey,
        request: { id },
      },
      async (tx) => {
        await this.assertActiveEmployee(tx, employeeId);
        const receipt = await tx.purchaseReceipt.findUnique({
          where: { id },
          include: {
            supplier: { select: { deletedAt: true } },
            items: {
              orderBy: { inventoryItemId: 'asc' },
              include: {
                inventoryItem: {
                  select: {
                    id: true,
                    deletedAt: true,
                    stock: true,
                    averageUnitCost: true,
                  },
                },
              },
            },
          },
        });
        if (!receipt) {
          throw new NotFoundException(
            `Purchase receipt with ID ${id} not found.`,
          );
        }
        if (receipt.status !== PurchaseReceiptStatus.DRAFT) {
          throw new ConflictException('Purchase receipt is no longer a draft.');
        }
        if (receipt.supplier.deletedAt) {
          throw new ConflictException('The supplier is inactive.');
        }
        if (receipt.items.length === 0) {
          throw new ConflictException(
            'A purchase receipt must contain at least one item.',
          );
        }

        const claimed = await tx.purchaseReceipt.updateMany({
          where: { id, status: PurchaseReceiptStatus.DRAFT },
          data: {
            status: PurchaseReceiptStatus.POSTED,
            postedAt: new Date(),
            postedById: employeeId,
          },
        });
        if (claimed.count !== 1) {
          throw new ConflictException('Purchase receipt is no longer a draft.');
        }

        const pendingMovements: Array<
          Omit<InventoryMovementResult, 'transactionId'> & {
            purchaseReceiptItemId: string;
          }
        > = [];
        for (const line of receipt.items) {
          const item = line.inventoryItem;
          if (item.deletedAt) {
            throw new ConflictException(
              `Inventory item ${item.id} is inactive.`,
            );
          }
          const averageUnitCost = calculateWeightedAverageCost({
            stock: item.stock,
            averageUnitCost: item.averageUnitCost,
            importedQuantity: line.quantity,
            importedUnitCost: line.unitPrice,
          });
          const stockAfter = item.stock.add(line.quantity);
          const updated = await tx.inventoryItem.updateMany({
            where: {
              id: item.id,
              deletedAt: null,
              stock: item.stock,
              averageUnitCost: item.averageUnitCost,
            },
            data: { stock: stockAfter, averageUnitCost },
          });
          if (updated.count !== 1) {
            throw new ConflictException(
              `Inventory item ${item.id} changed while posting. Retry the request.`,
            );
          }
          pendingMovements.push({
            inventoryItemId: item.id,
            purchaseReceiptItemId: line.id,
            type: InventoryTxType.IMPORT,
            quantity: line.quantity,
            unitCost: line.unitPrice,
            totalAmount: line.totalAmount,
            stockAfter,
            averageUnitCost,
          });
        }

        const transactions = await tx.inventoryTransaction.createManyAndReturn({
          data: pendingMovements.map(
            ({ purchaseReceiptItemId, ...movement }) => ({
              inventoryItemId: movement.inventoryItemId,
              purchaseReceiptItemId,
              type: movement.type,
              quantity: movement.quantity,
              unitPrice: movement.unitCost,
              totalAmount: movement.totalAmount,
              transactionDate: receipt.receivedAt,
              note: `Purchase receipt ${receipt.receiptNumber}`,
            }),
          ),
          select: { id: true, purchaseReceiptItemId: true },
        });
        const transactionIdByLineId = new Map(
          transactions.map((transaction) => [
            transaction.purchaseReceiptItemId,
            transaction.id,
          ]),
        );
        const movements: InventoryMovementResult[] = pendingMovements.map(
          ({ purchaseReceiptItemId, ...movement }) => {
            const transactionId = transactionIdByLineId.get(
              purchaseReceiptItemId,
            );
            if (!transactionId) {
              throw new ConflictException(
                'Purchase receipt ledger could not be persisted consistently.',
              );
            }
            return { ...movement, transactionId };
          },
        );

        await this.inventoryAudit.log(tx, {
          employeeId,
          actionType: 'INVENTORY_PURCHASE_RECEIPT_POSTED',
          details: {
            purchaseReceiptId: receipt.id,
            receiptNumber: receipt.receiptNumber,
            movements: this.auditMovements(movements),
          },
        });
        await this.outbox.enqueue(tx, {
          topic: 'inventory',
          eventName: INVENTORY_EVENTS.PURCHASE_RECEIPT_POSTED,
          aggregateType: 'PurchaseReceipt',
          aggregateId: receipt.id,
          payload: {
            eventId: randomUUID(),
            occurredAt: new Date().toISOString(),
            inventoryItemIds: movements.map(
              ({ inventoryItemId }) => inventoryItemId,
            ),
            documentId: receipt.id,
            documentNumber: receipt.receiptNumber,
            movements,
          },
        });
        return {
          id: receipt.id,
          receiptNumber: receipt.receiptNumber,
          status: PurchaseReceiptStatus.POSTED,
          movements,
        };
      },
    );
  }

  cancel(id: string, employeeId: string, { reason }: CancelPurchaseReceiptDto) {
    return this.inventoryTransaction.runSerializable(async (tx) => {
      await this.assertActiveEmployee(tx, employeeId);
      await this.assertDraft(tx, id);
      const cancelled = await tx.purchaseReceipt.updateMany({
        where: { id, status: PurchaseReceiptStatus.DRAFT },
        data: {
          status: PurchaseReceiptStatus.CANCELLED,
          cancelledAt: new Date(),
          cancelledById: employeeId,
          cancellationReason: reason,
        },
      });
      if (cancelled.count !== 1) {
        throw new ConflictException('Purchase receipt is no longer a draft.');
      }
      await this.inventoryAudit.log(tx, {
        employeeId,
        actionType: 'INVENTORY_PURCHASE_RECEIPT_CANCELLED',
        details: { purchaseReceiptId: id, reason },
      });
      return { id, status: PurchaseReceiptStatus.CANCELLED };
    });
  }

  private async prepareLines(
    tx: ExtendedPrismaTransactionClient,
    items: ReceiptLineInput[],
  ) {
    const itemIds = items.map(({ inventoryItemId }) => inventoryItemId);
    this.inventoryPolicy.assertNoDuplicateInventoryItems(itemIds);
    const inventoryItems = await tx.inventoryItem.findMany({
      where: { id: { in: itemIds } },
      select: {
        id: true,
        name: true,
        unit: { select: { name: true } },
      },
    });
    if (inventoryItems.length !== itemIds.length) {
      throw new NotFoundException(
        'One or more active inventory items were not found.',
      );
    }
    const byId = new Map(inventoryItems.map((item) => [item.id, item]));
    return items
      .map((line) => {
        const item = byId.get(line.inventoryItemId)!;
        const quantity = this.inventoryPolicy.toPositiveDecimal(
          line.quantity,
          'quantity',
        );
        const unitPrice = this.inventoryPolicy.toNonNegativeMoney(
          line.unitPrice,
          'unitPrice',
        );
        return {
          inventoryItemId: item.id,
          inventoryItemName: item.name,
          unitName: item.unit.name,
          quantity,
          unitPrice,
          totalAmount: calculateInventoryValue(quantity, unitPrice),
        };
      })
      .sort((a, b) => a.inventoryItemId.localeCompare(b.inventoryItemId));
  }

  private total(lines: Array<{ totalAmount: Decimal }>) {
    return lines.reduce(
      (total, line) => total.add(line.totalAmount),
      new Decimal(0),
    );
  }

  private auditMovements(movements: InventoryMovementResult[]) {
    return movements.map((movement) => ({
      inventoryItemId: movement.inventoryItemId,
      transactionId: movement.transactionId,
      type: movement.type,
      quantity: movement.quantity.toString(),
      unitCost: movement.unitCost.toString(),
      totalAmount: movement.totalAmount.toString(),
      stockAfter: movement.stockAfter.toString(),
      averageUnitCost: movement.averageUnitCost.toString(),
    }));
  }

  private async assertDraft(tx: ExtendedPrismaTransactionClient, id: string) {
    const receipt = await tx.purchaseReceipt.findUnique({
      where: { id },
      select: { status: true },
    });
    if (!receipt) {
      throw new NotFoundException(`Purchase receipt with ID ${id} not found.`);
    }
    if (receipt.status !== PurchaseReceiptStatus.DRAFT) {
      throw new ConflictException('Only draft purchase receipts can change.');
    }
  }

  private async assertActiveSupplier(
    tx: ExtendedPrismaTransactionClient,
    supplierId: string,
  ) {
    const supplier = await tx.supplier.findFirst({
      where: { id: supplierId, deletedAt: null },
      select: { id: true },
    });
    if (!supplier) {
      throw new NotFoundException(`Supplier with ID ${supplierId} not found.`);
    }
  }

  private async assertActiveEmployee(
    tx: ExtendedPrismaTransactionClient,
    employeeId: string,
  ) {
    const employee = await tx.employee.findFirst({
      where: { id: employeeId, deletedAt: null },
      select: { isActive: true },
    });
    this.inventoryPolicy.assertActiveEmployee(employee);
  }

  private documentNumber(prefix: string) {
    const date = new Date().toISOString().slice(0, 10).replaceAll('-', '');
    const suffix = randomUUID().replaceAll('-', '').slice(0, 12).toUpperCase();
    return `${prefix}-${date}-${suffix}`;
  }

  private readonly detailInclude = {
    supplier: { select: { id: true, code: true, name: true } },
    createdBy: { select: { id: true, fullName: true } },
    postedBy: { select: { id: true, fullName: true } },
    cancelledBy: { select: { id: true, fullName: true } },
    items: {
      orderBy: { inventoryItemId: 'asc' as const },
      include: {
        inventoryTransaction: {
          select: { id: true, transactionDate: true },
        },
      },
    },
  } as const;
}
