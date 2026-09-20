import { randomUUID } from 'node:crypto';
import { ConflictException, Injectable } from '@nestjs/common';
import { InventoryTxType } from '@prisma/client';
import { Decimal } from '@prisma/client/runtime/library';
import type {
  ExtendedPrismaTransactionClient,
  InventoryMovementResult,
} from '../../../common/types';
import { IdempotencyService } from '../../durable/idempotency.service';
import { OutboxService } from '../../durable/outbox.service';
import {
  BulkInventoryMovementDto,
  InventoryMovementDto,
} from '../dto/inventory-common.dto';
import { INVENTORY_EVENTS } from '../events/inventory.events';
import { InventoryPolicyService } from '../policies/inventory-policy.service';
import { InventoryRepository } from '../repositories/inventory.repository';
import { InventoryAuditService } from './inventory-audit.service';
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
    dto: InventoryMovementDto,
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
    dto: InventoryMovementDto,
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
          unitPrice: dto.unitPrice,
          transactionDate: dto.transactionDate,
          note: dto.note,
        },
      ],
    );
    return movement;
  }

  async bulkImport(employeeId: string, dto: BulkInventoryMovementDto) {
    this.inventoryPolicy.assertBulkSize(dto.items.length);
    this.inventoryPolicy.assertNoDuplicateInventoryItems(
      dto.items.map((item) => item.inventoryItemId),
    );

    return this.executeMovement(
      employeeId,
      'inventory.stock.bulk-import',
      dto.idempotencyKey,
      { ...dto, idempotencyKey: undefined },
      dto.items.map((item) => ({
        ...item,
        type: InventoryTxType.IMPORT,
      })),
    );
  }

  async bulkExport(employeeId: string, dto: BulkInventoryMovementDto) {
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
    const employee = await tx.employee.findUnique({
      where: { id: employeeId },
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
          stockAfter: result.stockAfter.toString(),
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
    await this.inventoryRepository.ensureActiveItemExists(
      movement.inventoryItemId,
      tx,
    );

    const quantity = this.inventoryPolicy.toPositiveDecimal(
      movement.quantity,
      'quantity',
    );
    const unitPrice =
      movement.unitPrice !== undefined
        ? this.inventoryPolicy.toNonNegativeDecimal(
            movement.unitPrice,
            'unitPrice',
          )
        : null;
    const totalAmount = unitPrice
      ? unitPrice.mul(quantity).toDecimalPlaces(2)
      : null;

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
      await tx.inventoryItem.update({
        where: { id: movement.inventoryItemId },
        data: {
          stock: { increment: quantity },
        },
      });
    }

    const transaction = await tx.inventoryTransaction.create({
      data: {
        inventoryItemId: movement.inventoryItemId,
        type: movement.type,
        quantity,
        unitPrice,
        totalAmount,
        transactionDate: movement.transactionDate ?? new Date(),
        note: movement.note ?? null,
      },
      select: { id: true },
    });

    const item = await tx.inventoryItem.findUnique({
      where: { id: movement.inventoryItemId },
      select: { stock: true },
    });

    return {
      inventoryItemId: movement.inventoryItemId,
      transactionId: transaction.id,
      type: movement.type,
      quantity,
      stockAfter: item?.stock ?? new Decimal(0),
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
