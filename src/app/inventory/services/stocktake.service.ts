import { randomUUID } from 'node:crypto';
import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InventoryTxType, Prisma, StocktakeStatus } from '@prisma/client';
import type {
  ExtendedPrismaTransactionClient,
  InventoryMovementResult,
} from '../../../common/types';
import { PaginationUtilService } from '../../../common/utils/pagination-util/pagination-util.service';
import { IdempotencyService } from '../../durable/idempotency.service';
import { OutboxService } from '../../durable/outbox.service';
import {
  CancelStocktakeDto,
  CreateStocktakeDto,
  GetStocktakesDto,
  PostStocktakeDto,
  UpdateStocktakeCountsDto,
} from '../dto';
import { INVENTORY_EVENTS } from '../events/inventory.events';
import { InventoryPolicyService } from '../policies/inventory-policy.service';
import { InventoryRepository } from '../repositories/inventory.repository';
import { InventoryAuditService } from './inventory-audit.service';
import { calculateInventoryValue } from './inventory-costing';
import { InventoryTransactionService } from './inventory-transaction.service';

@Injectable()
export class StocktakeService {
  constructor(
    private readonly inventoryRepository: InventoryRepository,
    private readonly inventoryPolicy: InventoryPolicyService,
    private readonly inventoryTransaction: InventoryTransactionService,
    private readonly inventoryAudit: InventoryAuditService,
    private readonly idempotency: IdempotencyService,
    private readonly outbox: OutboxService,
    private readonly pagination: PaginationUtilService,
  ) {}

  create(employeeId: string, dto: CreateStocktakeDto) {
    const { idempotencyKey, ...request } = dto;
    return this.idempotency.execute(
      {
        employeeId,
        operation: 'inventory.stocktake.create',
        key: idempotencyKey,
        request,
      },
      async (tx) => {
        await this.assertActiveEmployee(tx, employeeId);
        this.inventoryPolicy.assertNoDuplicateInventoryItems(
          request.inventoryItemIds,
        );
        const inventoryItems = await tx.inventoryItem.findMany({
          where: { id: { in: request.inventoryItemIds } },
          orderBy: { id: 'asc' },
          select: {
            id: true,
            name: true,
            stock: true,
            unit: { select: { name: true } },
          },
        });
        if (inventoryItems.length !== request.inventoryItemIds.length) {
          throw new NotFoundException(
            'One or more active inventory items were not found.',
          );
        }
        const stocktake = await tx.stocktake.create({
          data: {
            stocktakeNumber: this.documentNumber(),
            createdById: employeeId,
            note: request.note,
            items: {
              create: inventoryItems.map((item) => ({
                inventoryItemId: item.id,
                inventoryItemName: item.name,
                unitName: item.unit.name,
                expectedQuantity: item.stock,
              })),
            },
          },
          include: this.detailInclude,
        });
        await this.inventoryAudit.log(tx, {
          employeeId,
          actionType: 'INVENTORY_STOCKTAKE_CREATED',
          details: {
            stocktakeId: stocktake.id,
            stocktakeNumber: stocktake.stocktakeNumber,
            inventoryItemIds: request.inventoryItemIds,
          },
        });
        return stocktake;
      },
    );
  }

  async findAll({
    page,
    itemPerPage,
    status,
    createdFrom,
    createdTo,
  }: GetStocktakesDto) {
    const where: Prisma.StocktakeWhereInput = {
      ...(status ? { status } : {}),
      ...(createdFrom || createdTo
        ? {
            createdAt: {
              ...(createdFrom ? { gte: createdFrom } : {}),
              ...(createdTo ? { lte: createdTo } : {}),
            },
          }
        : {}),
    };
    const totalItems = await this.inventoryRepository.client.stocktake.count({
      where,
    });
    const paging = this.pagination.paging({ page, itemPerPage, totalItems });
    const stocktakes = await this.inventoryRepository.client.stocktake.findMany(
      {
        where,
        skip: paging.skip,
        take: paging.itemPerPage,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        include: {
          createdBy: { select: { id: true, fullName: true } },
          _count: { select: { items: true } },
        },
      },
    );
    return paging.format(stocktakes);
  }

  async findOne(id: string) {
    const stocktake =
      await this.inventoryRepository.client.stocktake.findUnique({
        where: { id },
        include: this.detailInclude,
      });
    if (!stocktake) {
      throw new NotFoundException(`Stocktake with ID ${id} not found.`);
    }
    return stocktake;
  }

  updateCounts(id: string, employeeId: string, dto: UpdateStocktakeCountsDto) {
    return this.inventoryTransaction.runSerializable(async (tx) => {
      await this.assertActiveEmployee(tx, employeeId);
      await this.assertDraft(tx, id);
      const itemIds = dto.items.map(({ inventoryItemId }) => inventoryItemId);
      this.inventoryPolicy.assertNoDuplicateInventoryItems(itemIds);
      const existingItems = await tx.stocktakeItem.findMany({
        where: { stocktakeId: id, inventoryItemId: { in: itemIds } },
        select: { id: true, inventoryItemId: true },
      });
      if (existingItems.length !== itemIds.length) {
        throw new NotFoundException(
          'One or more items do not belong to this stocktake.',
        );
      }
      const itemIdByInventoryItemId = new Map(
        existingItems.map((item) => [item.inventoryItemId, item.id]),
      );
      const countedAt = new Date();
      for (const item of [...dto.items].sort((a, b) =>
        a.inventoryItemId.localeCompare(b.inventoryItemId),
      )) {
        await tx.stocktakeItem.update({
          where: { id: itemIdByInventoryItemId.get(item.inventoryItemId)! },
          data: {
            countedQuantity: this.inventoryPolicy.toNonNegativeDecimal(
              item.countedQuantity,
              'countedQuantity',
            ),
            countedAt,
            differenceQuantity: null,
          },
        });
      }
      await this.inventoryAudit.log(tx, {
        employeeId,
        actionType: 'INVENTORY_STOCKTAKE_COUNTED',
        details: { stocktakeId: id, inventoryItemIds: itemIds },
      });
      return tx.stocktake.findUnique({
        where: { id },
        include: this.detailInclude,
      });
    });
  }

  post(id: string, employeeId: string, { idempotencyKey }: PostStocktakeDto) {
    return this.idempotency.execute(
      {
        employeeId,
        operation: 'inventory.stocktake.post',
        key: idempotencyKey,
        request: { id },
      },
      async (tx) => {
        await this.assertActiveEmployee(tx, employeeId);
        const stocktake = await tx.stocktake.findUnique({
          where: { id },
          include: {
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
        if (!stocktake) {
          throw new NotFoundException(`Stocktake with ID ${id} not found.`);
        }
        if (stocktake.status !== StocktakeStatus.DRAFT) {
          throw new ConflictException('Stocktake is no longer a draft.');
        }
        if (stocktake.items.length === 0) {
          throw new ConflictException(
            'A stocktake must contain at least one item.',
          );
        }
        if (stocktake.items.some((item) => item.countedQuantity === null)) {
          throw new ConflictException(
            'Every stocktake item must be counted before posting.',
          );
        }

        const claimed = await tx.stocktake.updateMany({
          where: { id, status: StocktakeStatus.DRAFT },
          data: {
            status: StocktakeStatus.POSTED,
            postedAt: new Date(),
            postedById: employeeId,
          },
        });
        if (claimed.count !== 1) {
          throw new ConflictException('Stocktake is no longer a draft.');
        }

        const pendingMovements: Array<
          Omit<InventoryMovementResult, 'transactionId'> & {
            stocktakeItemId: string;
          }
        > = [];
        const transactionDate = new Date();
        for (const line of stocktake.items) {
          const item = line.inventoryItem;
          if (item.deletedAt) {
            throw new ConflictException(
              `Inventory item ${item.id} is inactive.`,
            );
          }
          if (!item.stock.eq(line.expectedQuantity)) {
            throw new ConflictException(
              `Inventory item ${item.id} changed after the stocktake snapshot. Recount is required.`,
            );
          }

          const countedQuantity = line.countedQuantity!;
          const difference = countedQuantity.sub(line.expectedQuantity);
          const updated = await tx.inventoryItem.updateMany({
            where: {
              id: item.id,
              deletedAt: null,
              stock: line.expectedQuantity,
            },
            data: { stock: countedQuantity },
          });
          if (updated.count !== 1) {
            throw new ConflictException(
              `Inventory item ${item.id} changed while posting. Recount is required.`,
            );
          }
          if (!difference.isZero()) {
            const quantity = difference.abs();
            const totalAmount = calculateInventoryValue(
              quantity,
              item.averageUnitCost,
            );
            const type = difference.isPositive()
              ? InventoryTxType.IMPORT
              : InventoryTxType.EXPORT;
            pendingMovements.push({
              inventoryItemId: item.id,
              stocktakeItemId: line.id,
              type,
              quantity,
              unitCost: item.averageUnitCost,
              totalAmount,
              stockAfter: countedQuantity,
              averageUnitCost: item.averageUnitCost,
            });
          }
          await tx.stocktakeItem.update({
            where: { id: line.id },
            data: { differenceQuantity: difference },
          });
        }

        const transactions =
          pendingMovements.length > 0
            ? await tx.inventoryTransaction.createManyAndReturn({
                data: pendingMovements.map(
                  ({ stocktakeItemId, ...movement }) => ({
                    inventoryItemId: movement.inventoryItemId,
                    stocktakeItemId,
                    type: movement.type,
                    quantity: movement.quantity,
                    unitPrice: movement.unitCost,
                    totalAmount: movement.totalAmount,
                    transactionDate,
                    note: `Stocktake ${stocktake.stocktakeNumber}`,
                  }),
                ),
                select: { id: true, stocktakeItemId: true },
              })
            : [];
        const transactionIdByLineId = new Map(
          transactions.map((transaction) => [
            transaction.stocktakeItemId,
            transaction.id,
          ]),
        );
        const movements: InventoryMovementResult[] = pendingMovements.map(
          ({ stocktakeItemId, ...movement }) => {
            const transactionId = transactionIdByLineId.get(stocktakeItemId);
            if (!transactionId) {
              throw new ConflictException(
                'Stocktake ledger could not be persisted consistently.',
              );
            }
            return { ...movement, transactionId };
          },
        );

        await this.inventoryAudit.log(tx, {
          employeeId,
          actionType: 'INVENTORY_STOCKTAKE_POSTED',
          details: {
            stocktakeId: stocktake.id,
            stocktakeNumber: stocktake.stocktakeNumber,
            movements: this.auditMovements(movements),
          },
        });
        await this.outbox.enqueue(tx, {
          topic: 'inventory',
          eventName: INVENTORY_EVENTS.STOCKTAKE_POSTED,
          aggregateType: 'Stocktake',
          aggregateId: stocktake.id,
          payload: {
            eventId: randomUUID(),
            occurredAt: new Date().toISOString(),
            inventoryItemIds: movements.map(
              ({ inventoryItemId }) => inventoryItemId,
            ),
            documentId: stocktake.id,
            documentNumber: stocktake.stocktakeNumber,
            movements,
          },
        });
        return {
          id: stocktake.id,
          stocktakeNumber: stocktake.stocktakeNumber,
          status: StocktakeStatus.POSTED,
          movements,
        };
      },
    );
  }

  cancel(id: string, employeeId: string, { reason }: CancelStocktakeDto) {
    return this.inventoryTransaction.runSerializable(async (tx) => {
      await this.assertActiveEmployee(tx, employeeId);
      await this.assertDraft(tx, id);
      const cancelled = await tx.stocktake.updateMany({
        where: { id, status: StocktakeStatus.DRAFT },
        data: {
          status: StocktakeStatus.CANCELLED,
          cancelledAt: new Date(),
          cancelledById: employeeId,
          cancellationReason: reason,
        },
      });
      if (cancelled.count !== 1) {
        throw new ConflictException('Stocktake is no longer a draft.');
      }
      await this.inventoryAudit.log(tx, {
        employeeId,
        actionType: 'INVENTORY_STOCKTAKE_CANCELLED',
        details: { stocktakeId: id, reason },
      });
      return { id, status: StocktakeStatus.CANCELLED };
    });
  }

  private async assertDraft(tx: ExtendedPrismaTransactionClient, id: string) {
    const stocktake = await tx.stocktake.findUnique({
      where: { id },
      select: { status: true },
    });
    if (!stocktake) {
      throw new NotFoundException(`Stocktake with ID ${id} not found.`);
    }
    if (stocktake.status !== StocktakeStatus.DRAFT) {
      throw new ConflictException('Only draft stocktakes can change.');
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

  private auditMovements(movements: InventoryMovementResult[]) {
    return movements.map((movement) => ({
      inventoryItemId: movement.inventoryItemId,
      transactionId: movement.transactionId,
      type: movement.type,
      quantity: movement.quantity.toString(),
      unitCost: movement.unitCost.toString(),
      totalAmount: movement.totalAmount.toString(),
      stockAfter: movement.stockAfter.toString(),
    }));
  }

  private documentNumber() {
    const date = new Date().toISOString().slice(0, 10).replaceAll('-', '');
    const suffix = randomUUID().replaceAll('-', '').slice(0, 12).toUpperCase();
    return `ST-${date}-${suffix}`;
  }

  private readonly detailInclude = {
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
