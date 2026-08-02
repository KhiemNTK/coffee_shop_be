import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { ExtendedPrismaTransactionClient } from '../../../common/types';
import { PaginationUtilService } from '../../../common/utils/pagination-util/pagination-util.service';
import { QueryUtilService } from '../../../common/utils/query-util/query-util.service';
import {
  CreateInventoryCategoryDto,
  GetInventoryCategoriesDto,
  UpdateInventoryCategoryDto,
} from '../dto/inventory-category.dto';
import { InventoryPolicyService } from '../policies/inventory-policy.service';
import { InventoryRepository } from '../repositories/inventory.repository';
import { InventoryAuditService } from './inventory-audit.service';
import { InventoryTransactionService } from './inventory-transaction.service';

@Injectable()
export class InventoryCategoryService {
  constructor(
    private readonly inventoryRepository: InventoryRepository,
    private readonly paginationUtilService: PaginationUtilService,
    private readonly queryUtilService: QueryUtilService,
    private readonly inventoryPolicy: InventoryPolicyService,
    private readonly inventoryTransactionService: InventoryTransactionService,
    private readonly inventoryAuditService: InventoryAuditService,
  ) {}

  async create(employeeId: string, dto: CreateInventoryCategoryDto) {
    await this.inventoryRepository.ensureCategoryNameAvailable(dto.name);

    return this.inventoryTransactionService.runSerializable(async (tx) => {
      await this.assertActiveEmployee(tx, employeeId);
      const category = await tx.inventoryCategory.create({
        data: dto,
      });
      await this.inventoryAuditService.log(tx, {
        employeeId,
        actionType: 'INVENTORY_CATEGORY_CREATED',
        details: { categoryId: category.id, name: category.name },
      });
      return category;
    });
  }

  async findAll({
    page,
    itemPerPage,
    select,
    keyword,
  }: GetInventoryCategoriesDto) {
    const fieldsSelect =
      this.queryUtilService.convertFieldsSelectOption<any>(select);
    const where: Prisma.InventoryCategoryWhereInput = {
      ...(keyword
        ? {
            OR: [
              {
                name: { contains: keyword, mode: Prisma.QueryMode.insensitive },
              },
              {
                description: {
                  contains: keyword,
                  mode: Prisma.QueryMode.insensitive,
                },
              },
            ],
          }
        : {}),
    };
    const totalItems =
      await this.inventoryRepository.client.inventoryCategory.count({ where });
    const paging = this.paginationUtilService.paging({
      page,
      itemPerPage,
      totalItems,
    });
    const list =
      await this.inventoryRepository.client.inventoryCategory.findMany({
        select: fieldsSelect,
        where,
        skip: paging.skip,
        take: paging.itemPerPage,
        orderBy: { createdAt: 'desc' },
      });

    return paging.format(list);
  }

  async findOne(id: string) {
    const category =
      await this.inventoryRepository.client.inventoryCategory.findUnique({
        where: { id },
        include: {
          _count: {
            select: { inventoryItems: true },
          },
        },
      });

    if (!category) {
      throw new NotFoundException(
        `Inventory category with ID ${id} not found.`,
      );
    }

    return category;
  }

  async update(
    id: string,
    employeeId: string,
    dto: UpdateInventoryCategoryDto,
  ) {
    await this.inventoryRepository.ensureActiveCategoryExists(id);
    if (dto.name) {
      await this.inventoryRepository.ensureCategoryNameAvailable(dto.name, id);
    }

    return this.inventoryTransactionService.runSerializable(async (tx) => {
      await this.assertActiveEmployee(tx, employeeId);
      const category = await tx.inventoryCategory.update({
        where: { id },
        data: dto,
      });
      await this.inventoryAuditService.log(tx, {
        employeeId,
        actionType: 'INVENTORY_CATEGORY_UPDATED',
        details: { categoryId: id, changes: dto },
      });
      return category;
    });
  }

  async remove(id: string, employeeId: string) {
    await this.inventoryRepository.ensureActiveCategoryExists(id);
    const linkedItemsCount =
      await this.inventoryRepository.client.inventoryItem.count({
        where: { categoryId: id },
      });
    this.inventoryPolicy.assertCanDeleteCategory(linkedItemsCount);

    await this.inventoryTransactionService.runSerializable(async (tx) => {
      await this.assertActiveEmployee(tx, employeeId);
      await tx.inventoryCategory.delete({ where: { id } });
      await this.inventoryAuditService.log(tx, {
        employeeId,
        actionType: 'INVENTORY_CATEGORY_DELETED',
        details: { categoryId: id },
      });
    });

    return {
      success: true,
      message: `Inventory category #${id} has been deleted successfully`,
    };
  }

  private async assertActiveEmployee(
    tx: ExtendedPrismaTransactionClient,
    employeeId: string,
  ) {
    const employee = await tx.employee.findUnique({
      where: { id: employeeId },
      select: { isActive: true },
    });
    this.inventoryPolicy.assertActiveEmployee(employee);
  }
}
