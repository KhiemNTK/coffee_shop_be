import { randomUUID } from 'node:crypto';
import { ConflictException, Injectable } from '@nestjs/common';
import { InventoryTxType, Prisma } from '@prisma/client';
import type {
  ExtendedPrismaTransactionClient,
  InventoryMovementResult,
  InventoryRequirement,
} from '../../../common/types';
import { OutboxService } from '../../durable/outbox.service';
import { INVENTORY_EVENTS } from '../events/inventory.events';
import { calculateInventoryValue } from './inventory-costing';

@Injectable()
export class InventoryConsumptionService {
  constructor(private readonly outbox: OutboxService) {}

  async canFulfill(
    client: Pick<ExtendedPrismaTransactionClient, 'inventoryItem'>,
    requirements: InventoryRequirement[],
  ) {
    const totals = this.totalRequirements(requirements);
    if (!totals.size) return true;
    const items = await client.inventoryItem.findMany({
      where: {
        id: { in: [...totals.keys()] },
        deletedAt: null,
        category: { deletedAt: null },
        unit: { deletedAt: null },
      },
      select: { id: true, stock: true, reservedStock: true },
    });
    return (
      items.length === totals.size &&
      items.every((item) =>
        item.stock.minus(item.reservedStock).gte(totals.get(item.id)!),
      )
    );
  }

  reserveSession(tx: ExtendedPrismaTransactionClient, orderSessionId: string) {
    return this.reservePendingItems(tx, { orderSessionId });
  }

  async reservePendingItems(
    tx: ExtendedPrismaTransactionClient,
    where: Prisma.OrderItemWhereInput,
  ) {
    const items = await tx.orderItem.findMany({
      where: { AND: [where, { serveStatus: 'PENDING' }] },
      select: {
        id: true,
        menuItemId: true,
        quantity: true,
        recipeSnapshottedAt: true,
        recipeIngredients: {
          select: { inventoryItemId: true, quantityPerItem: true },
        },
        inventoryReservations: {
          select: { inventoryItemId: true, quantity: true },
        },
      },
    });
    const legacyItems = items.filter((item) => !item.recipeSnapshottedAt);
    if (legacyItems.length) {
      const recipes = await tx.menuItemIngredient.findMany({
        where: {
          menuItemId: {
            in: [...new Set(legacyItems.map((item) => item.menuItemId))],
          },
        },
        select: { menuItemId: true, inventoryItemId: true, quantity: true },
      });
      for (const item of legacyItems) {
        item.recipeIngredients = recipes
          .filter((row) => row.menuItemId === item.menuItemId)
          .map((row) => ({
            inventoryItemId: row.inventoryItemId,
            quantityPerItem: row.quantity,
          }));
      }
      const snapshots = legacyItems.flatMap((item) =>
        item.recipeIngredients.map((row) => ({
          orderItemId: item.id,
          ...row,
        })),
      );
      if (snapshots.length)
        await tx.orderItemRecipeIngredient.createMany({ data: snapshots });
      await tx.orderItem.updateMany({
        where: {
          id: { in: legacyItems.map((item) => item.id) },
          recipeSnapshottedAt: null,
        },
        data: { recipeSnapshottedAt: new Date() },
      });
    }
    const reservations = items.flatMap((item) => {
      const required = item.recipeIngredients.map((row) => ({
        orderItemId: item.id,
        inventoryItemId: row.inventoryItemId,
        quantity: row.quantityPerItem.mul(item.quantity),
      }));
      if (!item.inventoryReservations.length) return required;
      const held = new Map(
        item.inventoryReservations.map((row) => [
          row.inventoryItemId,
          row.quantity,
        ]),
      );
      if (
        held.size !== required.length ||
        required.some((row) => !held.get(row.inventoryItemId)?.eq(row.quantity))
      ) {
        throw new ConflictException(
          'Reserved ingredients no longer match the order snapshot.',
        );
      }
      return [];
    });
    for (const [id, quantity] of this.totalRequirements(reservations)) {
      const changed = await tx.$executeRaw`
        UPDATE "InventoryItem" i SET "reservedStock" = i."reservedStock" + ${quantity}::numeric,
          "updatedAt" = CURRENT_TIMESTAMP
        WHERE i."id" = ${id} AND i."deletedAt" IS NULL
          AND i."stock" - i."reservedStock" >= ${quantity}::numeric
          AND EXISTS (SELECT 1 FROM "Unit" u WHERE u."id" = i."unitId" AND u."deletedAt" IS NULL)
          AND EXISTS (SELECT 1 FROM "InventoryCategory" c WHERE c."id" = i."categoryId" AND c."deletedAt" IS NULL)
      `;
      if (changed !== 1) this.insufficientStock();
    }
    if (reservations.length)
      await tx.inventoryReservation.createMany({ data: reservations });
  }

  async releaseReservations(
    tx: ExtendedPrismaTransactionClient,
    orderItemIds: string[],
  ) {
    if (!orderItemIds.length) return;
    const rows = await tx.inventoryReservation.findMany({
      where: { orderItemId: { in: orderItemIds } },
      select: { inventoryItemId: true, quantity: true },
    });
    for (const [id, quantity] of this.totalRequirements(rows)) {
      const changed = await tx.$executeRaw`
        UPDATE "InventoryItem" SET "reservedStock" = "reservedStock" - ${quantity}::numeric,
          "updatedAt" = CURRENT_TIMESTAMP
        WHERE "id" = ${id} AND "reservedStock" >= ${quantity}::numeric
      `;
      if (changed !== 1)
        throw new ConflictException(
          'Inventory reservation state changed. Reload before retrying.',
        );
    }
    if (rows.length)
      await tx.inventoryReservation.deleteMany({
        where: { orderItemId: { in: orderItemIds } },
      });
  }

  private totalRequirements(rows: InventoryRequirement[]) {
    const totals = new Map<string, Prisma.Decimal>();
    for (const row of rows)
      totals.set(
        row.inventoryItemId,
        (totals.get(row.inventoryItemId) ?? new Prisma.Decimal(0)).add(
          row.quantity,
        ),
      );
    return new Map([...totals].sort(([a], [b]) => a.localeCompare(b)));
  }

  private insufficientStock(): never {
    throw new ConflictException({
      code: 'INVENTORY_INSUFFICIENT_STOCK',
      message:
        'Insufficient available ingredients. Review the order before retrying.',
    });
  }

  async consumeOrderItem(
    tx: ExtendedPrismaTransactionClient,
    orderItem: {
      id: string;
      menuItemId: string;
      quantity: number;
      recipeSnapshottedAt?: Date | null;
    },
  ): Promise<InventoryMovementResult[]> {
    const inventoryItemSelect = {
      id: true,
      name: true,
      deletedAt: true,
      averageUnitCost: true,
      unit: { select: { name: true } },
    } as const;
    const recipe = orderItem.recipeSnapshottedAt
      ? (
          await tx.orderItemRecipeIngredient.findMany({
            where: { orderItemId: orderItem.id },
            orderBy: { inventoryItemId: 'asc' },
            select: {
              quantityPerItem: true,
              inventoryItem: { select: inventoryItemSelect },
            },
          })
        ).map(({ quantityPerItem, inventoryItem }) => ({
          quantity: quantityPerItem,
          inventoryItem,
        }))
      : await tx.menuItemIngredient.findMany({
          where: { menuItemId: orderItem.menuItemId },
          orderBy: { inventoryItemId: 'asc' },
          select: {
            quantity: true,
            inventoryItem: { select: inventoryItemSelect },
          },
        });

    if (recipe.some(({ inventoryItem }) => inventoryItem.deletedAt !== null)) {
      throw new ConflictException(
        'The menu recipe references an inactive inventory item.',
      );
    }

    const ingredients = recipe.map(({ inventoryItem, quantity }) => {
      const totalQuantity = quantity.mul(orderItem.quantity);
      return {
        inventoryItemId: inventoryItem.id,
        inventoryItemName: inventoryItem.name,
        unitName: inventoryItem.unit.name,
        quantityPerItem: quantity,
        totalQuantity,
        unitCost: inventoryItem.averageUnitCost,
        totalCost: calculateInventoryValue(
          totalQuantity,
          inventoryItem.averageUnitCost,
        ),
      };
    });

    const reservations = await tx.inventoryReservation.findMany({
      where: { orderItemId: orderItem.id },
      select: { inventoryItemId: true, quantity: true },
    });
    const held = new Map(
      reservations.map((row) => [row.inventoryItemId, row.quantity]),
    );
    if (
      held.size &&
      (held.size !== ingredients.length ||
        ingredients.some(
          (row) => !held.get(row.inventoryItemId)?.eq(row.totalQuantity),
        ))
    )
      throw new ConflictException(
        'Reserved ingredients no longer match the order snapshot.',
      );
    for (const ingredient of ingredients) {
      const own = held.get(ingredient.inventoryItemId) ?? new Prisma.Decimal(0);
      const changed = await tx.$executeRaw`
        UPDATE "InventoryItem" SET "stock" = "stock" - ${ingredient.totalQuantity}::numeric,
          "reservedStock" = "reservedStock" - ${own}::numeric, "updatedAt" = CURRENT_TIMESTAMP
        WHERE "id" = ${ingredient.inventoryItemId} AND "deletedAt" IS NULL
          AND "reservedStock" >= ${own}::numeric
          AND "stock" - "reservedStock" >= ${ingredient.totalQuantity.minus(own)}::numeric
      `;
      if (changed !== 1) this.insufficientStock();
    }
    if (reservations.length)
      await tx.inventoryReservation.deleteMany({
        where: { orderItemId: orderItem.id },
      });

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
        unitPrice: ingredient.unitCost,
        totalAmount: ingredient.totalCost,
        transactionDate,
        note: 'Order recipe consumption',
      })),
      select: { id: true, inventoryItemId: true },
    });

    const stockRows = await tx.inventoryItem.findMany({
      where: {
        id: { in: ingredients.map(({ inventoryItemId }) => inventoryItemId) },
      },
      select: { id: true, stock: true, averageUnitCost: true },
    });
    const transactionIds = new Map(
      transactions.map((transaction) => [
        transaction.inventoryItemId,
        transaction.id,
      ]),
    );
    const stockByItemId = new Map(stockRows.map((item) => [item.id, item]));

    const movements = ingredients.map((ingredient) => {
      const transactionId = transactionIds.get(ingredient.inventoryItemId);
      const inventoryItem = stockByItemId.get(ingredient.inventoryItemId);
      if (!transactionId || !inventoryItem) {
        throw new ConflictException(
          'Inventory consumption could not be persisted consistently.',
        );
      }

      return {
        inventoryItemId: ingredient.inventoryItemId,
        transactionId,
        type: InventoryTxType.EXPORT,
        quantity: ingredient.totalQuantity,
        unitCost: ingredient.unitCost,
        totalAmount: ingredient.totalCost,
        stockAfter: inventoryItem.stock,
        averageUnitCost: inventoryItem.averageUnitCost,
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
