import { randomUUID } from 'node:crypto';
import { ConflictException, Injectable } from '@nestjs/common';
import { InventoryTxType } from '@prisma/client';
import type {
  ExtendedPrismaTransactionClient,
  InventoryMovementResult,
} from '../../../common/types';
import { OutboxService } from '../../durable/outbox.service';
import { INVENTORY_EVENTS } from '../events/inventory.events';

@Injectable()
export class InventoryConsumptionService {
  constructor(private readonly outbox: OutboxService) {}

  async consumeOrderItem(
    tx: ExtendedPrismaTransactionClient,
    orderItem: { id: string; menuItemId: string; quantity: number },
  ): Promise<InventoryMovementResult[]> {
    const recipe = await tx.menuItemIngredient.findMany({
      where: { menuItemId: orderItem.menuItemId },
      orderBy: { inventoryItemId: 'asc' },
      select: {
        quantity: true,
        inventoryItem: {
          select: {
            id: true,
            name: true,
            deletedAt: true,
            unit: { select: { name: true } },
          },
        },
      },
    });

    if (recipe.some(({ inventoryItem }) => inventoryItem.deletedAt !== null)) {
      throw new ConflictException(
        'The menu recipe references an inactive inventory item.',
      );
    }

    const ingredients = recipe.map(({ inventoryItem, quantity }) => ({
      inventoryItemId: inventoryItem.id,
      inventoryItemName: inventoryItem.name,
      unitName: inventoryItem.unit.name,
      quantityPerItem: quantity,
      totalQuantity: quantity.mul(orderItem.quantity),
    }));

    for (const ingredient of ingredients) {
      const updated = await tx.inventoryItem.updateMany({
        where: {
          id: ingredient.inventoryItemId,
          deletedAt: null,
          stock: { gte: ingredient.totalQuantity },
        },
        data: { stock: { decrement: ingredient.totalQuantity } },
      });

      if (updated.count !== 1) {
        throw new ConflictException(
          `Insufficient stock for inventory item '${ingredient.inventoryItemName}'.`,
        );
      }
    }

    if (ingredients.length === 0) return [];

    await tx.orderItemIngredientSnapshot.createMany({
      data: ingredients.map((ingredient) => ({
        orderItemId: orderItem.id,
        ...ingredient,
      })),
    });

    const transactionDate = new Date();
    const transactions = await tx.inventoryTransaction.createManyAndReturn({
      data: ingredients.map((ingredient) => ({
        inventoryItemId: ingredient.inventoryItemId,
        orderItemId: orderItem.id,
        type: InventoryTxType.EXPORT,
        quantity: ingredient.totalQuantity,
        unitPrice: null,
        totalAmount: null,
        transactionDate,
        note: 'Order recipe consumption',
      })),
      select: { id: true, inventoryItemId: true },
    });

    const stockRows = await tx.inventoryItem.findMany({
      where: {
        id: { in: ingredients.map(({ inventoryItemId }) => inventoryItemId) },
      },
      select: { id: true, stock: true },
    });
    const transactionIds = new Map(
      transactions.map((transaction) => [
        transaction.inventoryItemId,
        transaction.id,
      ]),
    );
    const stocks = new Map(stockRows.map((item) => [item.id, item.stock]));

    const movements = ingredients.map((ingredient) => {
      const transactionId = transactionIds.get(ingredient.inventoryItemId);
      const stockAfter = stocks.get(ingredient.inventoryItemId);
      if (!transactionId || !stockAfter) {
        throw new ConflictException(
          'Inventory consumption could not be persisted consistently.',
        );
      }

      return {
        inventoryItemId: ingredient.inventoryItemId,
        transactionId,
        type: InventoryTxType.EXPORT,
        quantity: ingredient.totalQuantity,
        stockAfter,
      };
    });
    await this.outbox.enqueue(tx, {
      topic: 'inventory',
      eventName: INVENTORY_EVENTS.STOCK_EXPORTED,
      aggregateType: 'OrderItem',
      aggregateId: orderItem.id,
      payload: {
        eventId: randomUUID(),
        occurredAt: new Date().toISOString(),
        inventoryItemIds: movements.map(
          ({ inventoryItemId }) => inventoryItemId,
        ),
        type: InventoryTxType.EXPORT,
        movements,
      },
    });
    return movements;
  }

  async recordWaste(
    tx: ExtendedPrismaTransactionClient,
    input: { orderItemId: string; employeeId: string; reason: string },
  ) {
    const snapshots = await tx.orderItemIngredientSnapshot.findMany({
      where: { orderItemId: input.orderItemId },
      orderBy: { inventoryItemId: 'asc' },
      select: { inventoryItemId: true, totalQuantity: true },
    });

    if (snapshots.length === 0) return [];

    return tx.inventoryWaste.createManyAndReturn({
      data: snapshots.map((snapshot) => ({
        orderItemId: input.orderItemId,
        inventoryItemId: snapshot.inventoryItemId,
        quantity: snapshot.totalQuantity,
        reason: input.reason,
        employeeId: input.employeeId,
      })),
      select: { id: true, inventoryItemId: true, quantity: true },
    });
  }
}
