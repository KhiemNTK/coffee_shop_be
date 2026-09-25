import { Injectable } from '@nestjs/common';
import { InventoryTxType, Prisma } from '@prisma/client';
import { Decimal } from '@prisma/client/runtime/library';
import type { InventoryReorderAlertRow } from '../../../common/types';
import { PaginationUtilService } from '../../../common/utils/pagination-util/pagination-util.service';
import { QueryUtilService } from '../../../common/utils/query-util/query-util.service';
import {
  GetInventoryTransactionsDto,
  GetInventoryWasteDto,
} from '../dto/inventory-common.dto';
import {
  GetInventoryItemsDto,
  GetInventoryReorderAlertsDto,
} from '../dto/inventory-item.dto';
import { InventoryRepository } from '../repositories/inventory.repository';

@Injectable()
export class InventoryQueryService {
  constructor(
    private readonly inventoryRepository: InventoryRepository,
    private readonly paginationUtilService: PaginationUtilService,
    private readonly queryUtilService: QueryUtilService,
  ) {}

  async findItems({
    page,
    itemPerPage,
    select,
    keyword,
    categoryId,
    unitId,
    lowStockOnly,
    maxStock,
  }: GetInventoryItemsDto) {
    const fieldsSelect =
      this.queryUtilService.convertFieldsSelectOption<any>(select);
    const resolvedMaxStock =
      maxStock !== undefined ? new Decimal(maxStock) : new Decimal(5);
    const where: Prisma.InventoryItemWhereInput = {
      ...(keyword
        ? {
            name: { contains: keyword, mode: Prisma.QueryMode.insensitive },
          }
        : {}),
      ...(categoryId ? { categoryId } : {}),
      ...(unitId ? { unitId } : {}),
      ...(lowStockOnly ? { stock: { lte: resolvedMaxStock } } : {}),
    };
    const totalItems =
      await this.inventoryRepository.client.inventoryItem.count({ where });
    const paging = this.paginationUtilService.paging({
      page,
      itemPerPage,
      totalItems,
    });
    const list = await this.inventoryRepository.client.inventoryItem.findMany({
      ...(fieldsSelect
        ? { select: fieldsSelect }
        : {
            include: {
              category: { select: { id: true, name: true } },
              unit: { select: { id: true, name: true } },
            },
          }),
      where,
      skip: paging.skip,
      take: paging.itemPerPage,
      orderBy: { createdAt: 'desc' },
    });

    return paging.format(list);
  }

  async findTransactions({
    page,
    itemPerPage,
    select,
    inventoryItemId,
    orderItemId,
    type,
    transactionFrom,
    transactionTo,
  }: GetInventoryTransactionsDto) {
    const fieldsSelect =
      this.queryUtilService.convertFieldsSelectOption<any>(select);
    const where: Prisma.InventoryTransactionWhereInput = {
      ...(inventoryItemId ? { inventoryItemId } : {}),
      ...(orderItemId ? { orderItemId } : {}),
      ...(type ? { type: type } : {}),
      ...(transactionFrom || transactionTo
        ? {
            transactionDate: {
              ...(transactionFrom ? { gte: transactionFrom } : {}),
              ...(transactionTo ? { lte: transactionTo } : {}),
            },
          }
        : {}),
    };
    const totalItems =
      await this.inventoryRepository.client.inventoryTransaction.count({
        where,
      });
    const paging = this.paginationUtilService.paging({
      page,
      itemPerPage,
      totalItems,
    });
    const list =
      await this.inventoryRepository.client.inventoryTransaction.findMany({
        ...(fieldsSelect
          ? { select: fieldsSelect }
          : {
              include: {
                inventoryItem: {
                  select: {
                    id: true,
                    name: true,
                    unit: { select: { id: true, name: true } },
                    category: { select: { id: true, name: true } },
                  },
                },
                orderItem: {
                  select: {
                    id: true,
                    orderSessionId: true,
                    menuItem: { select: { id: true, name: true } },
                  },
                },
              },
            }),
        where,
        skip: paging.skip,
        take: paging.itemPerPage,
        orderBy: [{ transactionDate: 'desc' }, { id: 'desc' }],
      });

    return paging.format(list);
  }

  async findReorderAlerts({
    page,
    itemPerPage,
    keyword,
    categoryId,
  }: GetInventoryReorderAlertsDto) {
    const filters = [
      Prisma.sql`item."deletedAt" IS NULL`,
      Prisma.sql`item."reorderPoint" > 0`,
      Prisma.sql`item."stock" <= item."reorderPoint"`,
      ...(keyword ? [Prisma.sql`item."name" ILIKE ${`%${keyword}%`}`] : []),
      ...(categoryId ? [Prisma.sql`item."categoryId" = ${categoryId}`] : []),
    ];
    const where = Prisma.join(filters, ' AND ');
    const [countRow] = await this.inventoryRepository.client.$queryRaw<
      Array<{ count: bigint }>
    >(Prisma.sql`
      SELECT COUNT(*)::bigint AS "count"
      FROM "InventoryItem" item
      WHERE ${where}
    `);
    const paging = this.paginationUtilService.paging({
      page,
      itemPerPage,
      totalItems: Number(countRow?.count ?? 0),
    });
    const list = await this.inventoryRepository.client.$queryRaw<
      InventoryReorderAlertRow[]
    >(Prisma.sql`
      SELECT
        item."id",
        item."name",
        item."stock",
        item."reorderPoint",
        item."reorderPoint" - item."stock" AS "shortageQuantity",
        item."averageUnitCost",
        unit."name" AS "unitName",
        category."name" AS "categoryName"
      FROM "InventoryItem" item
      JOIN "Unit" unit ON unit."id" = item."unitId"
      JOIN "InventoryCategory" category ON category."id" = item."categoryId"
      WHERE ${where}
      ORDER BY
        (item."stock" / NULLIF(item."reorderPoint", 0)) ASC,
        item."name" ASC
      LIMIT ${paging.itemPerPage}
      OFFSET ${paging.skip}
    `);

    return paging.format(list);
  }

  async findWaste({
    page,
    itemPerPage,
    inventoryItemId,
    orderItemId,
    createdFrom,
    createdTo,
  }: GetInventoryWasteDto) {
    const where: Prisma.InventoryWasteWhereInput = {
      ...(inventoryItemId ? { inventoryItemId } : {}),
      ...(orderItemId ? { orderItemId } : {}),
      ...(createdFrom || createdTo
        ? {
            createdAt: {
              ...(createdFrom ? { gte: createdFrom } : {}),
              ...(createdTo ? { lte: createdTo } : {}),
            },
          }
        : {}),
    };
    const totalItems =
      await this.inventoryRepository.client.inventoryWaste.count({ where });
    const paging = this.paginationUtilService.paging({
      page,
      itemPerPage,
      totalItems,
    });
    const list = await this.inventoryRepository.client.inventoryWaste.findMany({
      where,
      skip: paging.skip,
      take: paging.itemPerPage,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      include: {
        employee: { select: { id: true, fullName: true } },
        snapshot: {
          select: {
            inventoryItemName: true,
            unitName: true,
            orderItem: {
              select: {
                id: true,
                orderSessionId: true,
                menuItem: { select: { id: true, name: true } },
              },
            },
          },
        },
      },
    });

    return paging.format(list);
  }
}
