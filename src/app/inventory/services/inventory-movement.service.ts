import { randomUUID } from 'node:crypto';
import { ConflictException, Injectable } from '@nestjs/common';
import { InventoryTxType } from '@prisma/client';
import { Decimal } from '@prisma/client/runtime/library';
import type {
  ExtendedPrismaTransactionClient,
  InventoryEventBase,
  InventoryMovementResult,
} from '../../../common/types';
import {
  BulkInventoryMovementDto,
  InventoryMovementDto,
} from '../dto/inventory-common.dto';
import { INVENTORY_EVENTS } from '../events/inventory.events';
import { InventoryEventsPublisher } from '../events/inventory-events.publisher';
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
    private readonly inventoryEventsPublisher: InventoryEventsPublisher,
  ) {}

  async importItem(
    inventoryItemId: string,
    employeeId: string,
    dto: InventoryMovementDto,
  ) {
    this.inventoryPolicy.assertNoIdempotencyKey(dto.idempotencyKey);
    const [movement] = await this.moveStock(employeeId, [
      {
        inventoryItemId,
        type: InventoryTxType.IMPORT,
        quantity: dto.quantity,
        unitPrice: dto.unitPrice,
        transactionDate: dto.transactionDate,
        note: dto.note,
      },
    ]);

    this.emitStockEvent(INVENTORY_EVENTS.STOCK_IMPORTED, [movement]);
    return movement;
  }

  async exportItem(
    inventoryItemId: string,
    employeeId: string,
    dto: InventoryMovementDto,
  ) {
    this.inventoryPolicy.assertNoIdempotencyKey(dto.idempotencyKey);
    const [movement] = await this.moveStock(employeeId, [
      {
        inventoryItemId,
        type: InventoryTxType.EXPORT,
        quantity: dto.quantity,
        unitPrice: dto.unitPrice,
        transactionDate: dto.transactionDate,
        note: dto.note,
      },
    ]);

    this.emitStockEvent(INVENTORY_EVENTS.STOCK_EXPORTED, [movement]);
    return movement;
  }

  async bulkImport(employeeId: string, dto: BulkInventoryMovementDto) {
    this.inventoryPolicy.assertNoIdempotencyKey(dto.idempotencyKey);
    this.inventoryPolicy.assertBulkSize(dto.items.length);
    this.inventoryPolicy.assertNoDuplicateInventoryItems(
      dto.items.map((item) => item.inventoryItemId),
    );

    const movements = await this.moveStock(
      employeeId,
      dto.items.map((item) => ({
        ...item,
        type: InventoryTxType.IMPORT,
      })),
    );

    this.emitStockEvent(INVENTORY_EVENTS.STOCK_IMPORTED, movements);
    return movements;
  }

  async bulkExport(employeeId: string, dto: BulkInventoryMovementDto) {
    this.inventoryPolicy.assertNoIdempotencyKey(dto.idempotencyKey);
    this.inventoryPolicy.assertBulkSize(dto.items.length);
    this.inventoryPolicy.assertNoDuplicateInventoryItems(
      dto.items.map((item) => item.inventoryItemId),
    );

    const movements = await this.moveStock(
      employeeId,
      dto.items
        .map((item) => ({
          ...item,
          type: InventoryTxType.EXPORT,
        }))
        .sort((a, b) => a.inventoryItemId.localeCompare(b.inventoryItemId)),
    );

    this.emitStockEvent(INVENTORY_EVENTS.STOCK_EXPORTED, movements);
    return movements;
  }

  private async moveStock(
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
    return this.inventoryTransactionService.runSerializable(async (tx) => {
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

      return results;
    });
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

  private emitStockEvent(
    eventName:
      | typeof INVENTORY_EVENTS.STOCK_IMPORTED
      | typeof INVENTORY_EVENTS.STOCK_EXPORTED,
    movements: InventoryMovementResult[],
  ) {
    this.inventoryEventsPublisher.emit(eventName, {
      ...this.createEventBase(
        movements.map((movement) => movement.inventoryItemId),
      ),
      type: movements[0]?.type ?? InventoryTxType.IMPORT,
      movements,
    });
  }

  private createEventBase(inventoryItemIds: string[]): InventoryEventBase {
    return {
      eventId: randomUUID(),
      occurredAt: new Date().toISOString(),
      inventoryItemIds: [...new Set(inventoryItemIds)],
    };
  }
}
