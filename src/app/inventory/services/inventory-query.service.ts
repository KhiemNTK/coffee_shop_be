import { Injectable } from '@nestjs/common';
import { InventoryTxType, Prisma } from '@prisma/client';
import { Decimal } from '@prisma/client/runtime/library';
import { PaginationUtilService } from '../../../common/utils/pagination-util/pagination-util.service';
import { QueryUtilService } from '../../../common/utils/query-util/query-util.service';
import { GetInventoryTransactionsDto } from '../dto/inventory-common.dto';
import { GetInventoryItemsDto } from '../dto/inventory-item.dto';
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
    type,
    transactionFrom,
    transactionTo,
  }: GetInventoryTransactionsDto) {
    const fieldsSelect =
      this.queryUtilService.convertFieldsSelectOption<any>(select);
    const where: Prisma.InventoryTransactionWhereInput = {
      ...(inventoryItemId ? { inventoryItemId } : {}),
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
              },
            }),
        where,
        skip: paging.skip,
        take: paging.itemPerPage,
        orderBy: { transactionDate: 'desc' },
      });

    return paging.format(list);
  }
}
