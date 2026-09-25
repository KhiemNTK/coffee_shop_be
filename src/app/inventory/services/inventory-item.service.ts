import { randomUUID } from 'node:crypto';
import { Injectable, NotFoundException } from '@nestjs/common';
import {
  InventoryTxType,
  PurchaseReceiptStatus,
  StocktakeStatus,
} from '@prisma/client';
import { Decimal } from '@prisma/client/runtime/library';
import type { ExtendedPrismaTransactionClient } from '../../../common/types';
import { OutboxService } from '../../durable/outbox.service';
import {
  CreateInventoryItemDto,
  UpdateInventoryItemDto,
} from '../dto/inventory-item.dto';
import { INVENTORY_EVENTS } from '../events/inventory.events';
import { InventoryPolicyService } from '../policies/inventory-policy.service';
import { InventoryRepository } from '../repositories/inventory.repository';
import { InventoryAuditService } from './inventory-audit.service';
import { calculateInventoryValue } from './inventory-costing';
import { InventoryTransactionService } from './inventory-transaction.service';

@Injectable()
export class InventoryItemService {
  constructor(
    private readonly inventoryRepository: InventoryRepository,
    private readonly inventoryPolicy: InventoryPolicyService,
    private readonly inventoryTransactionService: InventoryTransactionService,
    private readonly inventoryAuditService: InventoryAuditService,
    private readonly outbox: OutboxService,
  ) {}

  async create(employeeId: string, dto: CreateInventoryItemDto) {
    const initialStock =
      dto.stock !== undefined
        ? this.inventoryPolicy.toNonNegativeDecimal(dto.stock, 'stock')
        : new Decimal(0);
    const initialUnitCost =
      dto.initialUnitCost !== undefined
        ? this.inventoryPolicy.toNonNegativeMoney(
            dto.initialUnitCost,
            'initialUnitCost',
          )
        : new Decimal(0);
    const reorderPoint =
      dto.reorderPoint !== undefined
        ? this.inventoryPolicy.toNonNegativeDecimal(
            dto.reorderPoint,
            'reorderPoint',
          )
        : new Decimal(0);

    const item = await this.inventoryTransactionService.runSerializable(
      async (tx) => {
        const employee = await tx.employee.findFirst({
          where: { id: employeeId, deletedAt: null },
          select: { isActive: true },
        });
        this.inventoryPolicy.assertActiveEmployee(employee);

        await this.inventoryRepository.ensureActiveCategoryExists(
          dto.categoryId,
          tx,
        );
        await this.inventoryRepository.ensureActiveUnitExists(dto.unitId, tx);
        await this.inventoryRepository.ensureItemNameAvailable({
          name: dto.name,
          categoryId: dto.categoryId,
          tx,
        });

        const created = await tx.inventoryItem.create({
          data: {
            name: dto.name,
            categoryId: dto.categoryId,
            unitId: dto.unitId,
            stock: initialStock,
            averageUnitCost: initialUnitCost,
            reorderPoint,
          },
          include: this.itemInclude,
        });

        if (initialStock.gt(0)) {
          await tx.inventoryTransaction.create({
            data: {
              inventoryItemId: created.id,
              type: InventoryTxType.IMPORT,
              quantity: initialStock,
              unitPrice: initialUnitCost,
              totalAmount: calculateInventoryValue(
                initialStock,
                initialUnitCost,
              ),
              transactionDate: new Date(),
              note: 'Initial stock',
            },
          });
        }

        await this.inventoryAuditService.log(tx, {
          employeeId,
          actionType: 'INVENTORY_ITEM_CREATED',
          details: {
            inventoryItemId: created.id,
            name: created.name,
            categoryId: created.categoryId,
            unitId: created.unitId,
            initialStock: initialStock.toString(),
            initialUnitCost: initialUnitCost.toString(),
            reorderPoint: reorderPoint.toString(),
          },
        });
        await this.enqueueItemEvent(
          tx,
          INVENTORY_EVENTS.ITEM_CREATED,
          created.id,
        );

        return created;
      },
    );
    return item;
  }

  async findOne(id: string) {
    const item = await this.inventoryRepository.client.inventoryItem.findUnique(
      {
        where: { id },
        include: {
          ...this.itemInclude,
          transactions: {
            take: 20,
            orderBy: { transactionDate: 'desc' },
          },
        },
      },
    );

    if (!item) {
      throw new NotFoundException(`Inventory item with ID ${id} not found.`);
    }

    return item;
  }

  async update(id: string, employeeId: string, dto: UpdateInventoryItemDto) {
    const item = await this.inventoryTransactionService.runSerializable(
      async (tx) => {
        const employee = await tx.employee.findFirst({
          where: { id: employeeId, deletedAt: null },
          select: { isActive: true },
        });
        this.inventoryPolicy.assertActiveEmployee(employee);

        const existing = await this.inventoryRepository.ensureActiveItemExists(
          id,
          tx,
        );
        const nextCategoryId = dto.categoryId ?? existing.categoryId;

        if (dto.categoryId) {
          await this.inventoryRepository.ensureActiveCategoryExists(
            dto.categoryId,
            tx,
          );
        }
        if (dto.unitId) {
          await this.inventoryRepository.ensureActiveUnitExists(dto.unitId, tx);
        }
        if (dto.name || dto.categoryId) {
          await this.inventoryRepository.ensureItemNameAvailable({
            name: dto.name ?? (await this.findItemNameInTransaction(tx, id)),
            categoryId: nextCategoryId,
            excludeId: id,
            tx,
          });
        }

        const { reorderPoint: nextReorderPoint, ...changes } = dto;
        const updated = await tx.inventoryItem.update({
          where: { id },
          data: {
            ...changes,
            ...(nextReorderPoint !== undefined
              ? {
                  reorderPoint: this.inventoryPolicy.toNonNegativeDecimal(
                    nextReorderPoint,
                    'reorderPoint',
                  ),
                }
              : {}),
          },
          include: this.itemInclude,
        });
        await this.inventoryAuditService.log(tx, {
          employeeId,
          actionType: 'INVENTORY_ITEM_UPDATED',
          details: { inventoryItemId: id, changes: dto },
        });
        await this.enqueueItemEvent(tx, INVENTORY_EVENTS.ITEM_UPDATED, id);
        return updated;
      },
    );
    return item;
  }

  async remove(id: string, employeeId: string) {
    await this.inventoryTransactionService.runSerializable(async (tx) => {
      const employee = await tx.employee.findFirst({
        where: { id: employeeId, deletedAt: null },
        select: { isActive: true },
      });
      this.inventoryPolicy.assertActiveEmployee(employee);

      const item = await this.inventoryRepository.ensureActiveItemExists(
        id,
        tx,
      );
      const [activeRecipeLinks, draftReceiptLinks, draftStocktakeLinks] =
        await Promise.all([
          tx.menuItemIngredient.count({ where: { inventoryItemId: id } }),
          tx.purchaseReceiptItem.count({
            where: {
              inventoryItemId: id,
              purchaseReceipt: { status: PurchaseReceiptStatus.DRAFT },
            },
          }),
          tx.stocktakeItem.count({
            where: {
              inventoryItemId: id,
              stocktake: { status: StocktakeStatus.DRAFT },
            },
          }),
        ]);
      this.inventoryPolicy.assertCanDeleteItem({
        activeRecipeLinks,
        draftDocumentLinks: draftReceiptLinks + draftStocktakeLinks,
        stock: item.stock,
      });

      await tx.inventoryItem.update({
        where: { id },
        data: { deletedAt: new Date() },
      });
      await this.inventoryAuditService.log(tx, {
        employeeId,
        actionType: 'INVENTORY_ITEM_DELETED',
        details: { inventoryItemId: id },
      });
      await this.enqueueItemEvent(tx, INVENTORY_EVENTS.ITEM_DELETED, id);
    });
    return {
      success: true,
      message: `Inventory item #${id} has been deleted successfully`,
    };
  }

  private readonly itemInclude = {
    category: { select: { id: true, name: true } },
    unit: { select: { id: true, name: true } },
  } as const;

  private async findItemNameInTransaction(
    tx: ExtendedPrismaTransactionClient,
    id: string,
  ) {
    const item = await tx.inventoryItem.findFirst({
      where: { id, deletedAt: null },
      select: { name: true },
    });

    if (!item) {
      throw new NotFoundException(`Inventory item with ID ${id} not found.`);
    }

    return item.name;
  }

  private enqueueItemEvent(
    tx: ExtendedPrismaTransactionClient,
    eventName:
      | typeof INVENTORY_EVENTS.ITEM_CREATED
      | typeof INVENTORY_EVENTS.ITEM_UPDATED
      | typeof INVENTORY_EVENTS.ITEM_DELETED,
    inventoryItemId: string,
  ) {
    return this.outbox.enqueue(tx, {
      topic: 'inventory',
      eventName,
      aggregateType: 'InventoryItem',
      aggregateId: inventoryItemId,
      payload: {
        eventId: randomUUID(),
        occurredAt: new Date().toISOString(),
        inventoryItemIds: [inventoryItemId],
        inventoryItemId,
      },
    });
  }
}
