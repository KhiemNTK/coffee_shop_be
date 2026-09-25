import { randomUUID } from 'node:crypto';
import {
  BadRequestException,
  ConflictException,
  Injectable,
} from '@nestjs/common';
import { InventoryTxType } from '@prisma/client';
import { Decimal } from '@prisma/client/runtime/library';
import type {
  ExtendedPrismaTransactionClient,
  InventoryMovementResult,
} from '../../../common/types';
import { IdempotencyService } from '../../durable/idempotency.service';
import { OutboxService } from '../../durable/outbox.service';
import {
  BulkInventoryExportDto,
  BulkInventoryImportDto,
  InventoryExportDto,
  InventoryImportDto,
} from '../dto/inventory-common.dto';
import { INVENTORY_EVENTS } from '../events/inventory.events';
import { InventoryPolicyService } from '../policies/inventory-policy.service';
import { InventoryRepository } from '../repositories/inventory.repository';
import { InventoryAuditService } from './inventory-audit.service';
import {
  calculateInventoryValue,
  calculateWeightedAverageCost,
} from './inventory-costing';
import { InventoryTransactionService } from './inventory-transaction.service';

@Injectable()
export class InventoryMovementService {
  constructor(
    private readonly inventoryRepository: InventoryRepository,
    private readonly inventoryPolicy: InventoryPolicyService,
    private readonly inventoryTransactionService: InventoryTransactionService,
    private readonly inventoryAuditService: InventoryAuditService,
    private readonly idempotency: IdempotencyService,
    private readonly outbox: OutboxService,
  ) {}

  async importItem(
    inventoryItemId: string,
    employeeId: string,
    dto: InventoryImportDto,
  ) {
    const [movement] = await this.executeMovement(
      employeeId,
      'inventory.stock.import',
      dto.idempotencyKey,
      { inventoryItemId, ...dto, idempotencyKey: undefined },
      [
        {
          inventoryItemId,
          type: InventoryTxType.IMPORT,
          quantity: dto.quantity,
          unitPrice: dto.unitPrice,
          transactionDate: dto.transactionDate,
          note: dto.note,
        },
      ],
    );
    return movement;
  }

  async exportItem(
    inventoryItemId: string,
    employeeId: string,
    dto: InventoryExportDto,
  ) {
    const [movement] = await this.executeMovement(
      employeeId,
      'inventory.stock.export',
      dto.idempotencyKey,
      { inventoryItemId, ...dto, idempotencyKey: undefined },
      [
        {
          inventoryItemId,
          type: InventoryTxType.EXPORT,
          quantity: dto.quantity,
          transactionDate: dto.transactionDate,
          note: dto.note,
        },
      ],
    );
    return movement;
  }

  async bulkImport(employeeId: string, dto: BulkInventoryImportDto) {
    this.inventoryPolicy.assertBulkSize(dto.items.length);
    this.inventoryPolicy.assertNoDuplicateInventoryItems(
      dto.items.map((item) => item.inventoryItemId),
    );

    return this.executeMovement(
      employeeId,
      'inventory.stock.bulk-import',
      dto.idempotencyKey,
      { ...dto, idempotencyKey: undefined },
      dto.items
        .map((item) => ({
          ...item,
          type: InventoryTxType.IMPORT,
        }))
        .sort((a, b) => a.inventoryItemId.localeCompare(b.inventoryItemId)),
    );
  }

  async bulkExport(employeeId: string, dto: BulkInventoryExportDto) {
    this.inventoryPolicy.assertBulkSize(dto.items.length);
    this.inventoryPolicy.assertNoDuplicateInventoryItems(
      dto.items.map((item) => item.inventoryItemId),
    );

    return this.executeMovement(
      employeeId,
      'inventory.stock.bulk-export',
      dto.idempotencyKey,
      { ...dto, idempotencyKey: undefined },
      dto.items
        .map((item) => ({
          ...item,
          type: InventoryTxType.EXPORT,
        }))
        .sort((a, b) => a.inventoryItemId.localeCompare(b.inventoryItemId)),
    );
  }

  private executeMovement(
    employeeId: string,
    operation: string,
    idempotencyKey: string | undefined,
    request: unknown,
    movements: Array<{
      inventoryItemId: string;
      type: InventoryTxType;
      quantity: string | number;
      unitPrice?: string | number;
      transactionDate?: Date;
      note?: string | null;
    }>,
  ) {
    const execute = (tx: ExtendedPrismaTransactionClient) =>
      this.moveStockInTransaction(tx, employeeId, movements);
    return idempotencyKey
      ? this.idempotency.execute(
          { employeeId, operation, key: idempotencyKey, request },
          execute,
        )
      : this.inventoryTransactionService.runSerializable(execute);
  }

  private async moveStockInTransaction(
    tx: ExtendedPrismaTransactionClient,
    employeeId: string,
    movements: Array<{
      inventoryItemId: string;
      type: InventoryTxType;
      quantity: string | number;
      unitPrice?: string | number;
      transactionDate?: Date;
      note?: string | null;
    }>,
  ) {
    const employee = await tx.employee.findFirst({
      where: { id: employeeId, deletedAt: null },
      select: { isActive: true },
    });
    this.inventoryPolicy.assertActiveEmployee(employee);

    const results: InventoryMovementResult[] = [];
    for (const movement of movements) {
      results.push(await this.applyMovement(tx, movement));
    }

    await this.inventoryAuditService.log(tx, {
      employeeId,
      actionType:
        movements[0]?.type === InventoryTxType.IMPORT
          ? 'INVENTORY_IMPORT'
          : 'INVENTORY_EXPORT',
      details: {
        movements: results.map((result) => ({
          inventoryItemId: result.inventoryItemId,
          transactionId: result.transactionId,
          type: result.type,
          quantity: result.quantity.toString(),
          unitCost: result.unitCost.toString(),
          totalAmount: result.totalAmount.toString(),
          stockAfter: result.stockAfter.toString(),
          averageUnitCost: result.averageUnitCost.toString(),
        })),
      },
    });
    await this.enqueueStockEvent(tx, results);
    return results;
  }

  private async applyMovement(
    tx: ExtendedPrismaTransactionClient,
    movement: {
      inventoryItemId: string;
      type: InventoryTxType;
      quantity: string | number;
      unitPrice?: string | number;
      transactionDate?: Date;
      note?: string | null;
    },
  ): Promise<InventoryMovementResult> {
    const item = await this.inventoryRepository.ensureActiveItemExists(
      movement.inventoryItemId,
      tx,
    );

    const quantity = this.inventoryPolicy.toPositiveDecimal(
      movement.quantity,
      'quantity',
    );
    let unitCost = item.averageUnitCost;
    if (movement.type === InventoryTxType.IMPORT) {
      if (movement.unitPrice === undefined) {
        throw new BadRequestException(
          'unitPrice is required for stock imports.',
        );
      }
      unitCost = this.inventoryPolicy.toNonNegativeMoney(
        movement.unitPrice,
        'unitPrice',
      );
    }
    const totalAmount = calculateInventoryValue(quantity, unitCost);

    if (movement.type === InventoryTxType.EXPORT) {
      const updated = await tx.inventoryItem.updateMany({
        where: {
          id: movement.inventoryItemId,
          stock: { gte: quantity },
        },
        data: {
          stock: { decrement: quantity },
        },
      });

      if (updated.count !== 1) {
        throw new ConflictException(
          `Insufficient stock for inventory item ${movement.inventoryItemId}.`,
        );
      }
    } else {
      const averageUnitCost = calculateWeightedAverageCost({
        stock: item.stock,
        averageUnitCost: item.averageUnitCost,
        importedQuantity: quantity,
        importedUnitCost: unitCost,
      });
      await tx.inventoryItem.update({
        where: { id: movement.inventoryItemId },
        data: {
          stock: { increment: quantity },
          averageUnitCost,
        },
      });
    }

    const transaction = await tx.inventoryTransaction.create({
      data: {
        inventoryItemId: movement.inventoryItemId,
        type: movement.type,
        quantity,
        unitPrice: unitCost,
        totalAmount,
        transactionDate: movement.transactionDate ?? new Date(),
        note: movement.note ?? null,
      },
      select: { id: true },
    });

    const updatedItem = await tx.inventoryItem.findFirst({
      where: { id: movement.inventoryItemId, deletedAt: null },
      select: { stock: true, averageUnitCost: true },
    });

    return {
      inventoryItemId: movement.inventoryItemId,
      transactionId: transaction.id,
      type: movement.type,
      quantity,
      unitCost,
      totalAmount,
      stockAfter: updatedItem?.stock ?? new Decimal(0),
      averageUnitCost: updatedItem?.averageUnitCost ?? new Decimal(0),
    };
  }

  private enqueueStockEvent(
    tx: ExtendedPrismaTransactionClient,
    movements: InventoryMovementResult[],
  ) {
    const type = movements[0]?.type ?? InventoryTxType.IMPORT;
    return this.outbox.enqueue(tx, {
      topic: 'inventory',
      eventName:
        type === InventoryTxType.IMPORT
          ? INVENTORY_EVENTS.STOCK_IMPORTED
          : INVENTORY_EVENTS.STOCK_EXPORTED,
      aggregateType: 'InventoryMovement',
      aggregateId: movements[0]?.transactionId ?? randomUUID(),
      payload: {
        eventId: randomUUID(),
        occurredAt: new Date().toISOString(),
        inventoryItemIds: [
          ...new Set(movements.map(({ inventoryItemId }) => inventoryItemId)),
        ],
        type,
        movements,
      },
    });
  }
}
