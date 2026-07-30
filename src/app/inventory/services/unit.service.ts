import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PaginationUtilService } from '../../../common/utils/pagination-util/pagination-util.service';
import { QueryUtilService } from '../../../common/utils/query-util/query-util.service';
import { CreateUnitDto, GetUnitsDto, UpdateUnitDto } from '../dto/unit.dto';
import { InventoryPolicyService } from '../policies/inventory-policy.service';
import { InventoryRepository } from '../repositories/inventory.repository';
import { InventoryAuditService } from './inventory-audit.service';
import { InventoryTransactionService } from './inventory-transaction.service';

@Injectable()
export class UnitService {
  constructor(
    private readonly inventoryRepository: InventoryRepository,
    private readonly paginationUtilService: PaginationUtilService,
    private readonly queryUtilService: QueryUtilService,
    private readonly inventoryPolicy: InventoryPolicyService,
    private readonly inventoryTransactionService: InventoryTransactionService,
    private readonly inventoryAuditService: InventoryAuditService,
  ) {}

  async create(employeeId: string, dto: CreateUnitDto) {
    await this.inventoryRepository.ensureUnitNameAvailable(dto.name);

    return this.inventoryTransactionService.runSerializable(async (tx) => {
      await this.assertActiveEmployee(tx, employeeId);
      const unit = await tx.unit.create({ data: dto });
      await this.inventoryAuditService.log(tx, {
        employeeId,
        actionType: 'INVENTORY_UNIT_CREATED',
        details: { unitId: unit.id, name: unit.name },
      });
      return unit;
    });
  }

  async findAll({ page, itemPerPage, select, keyword }: GetUnitsDto) {
    const fieldsSelect =
      this.queryUtilService.convertFieldsSelectOption<any>(select);
    const where: Prisma.UnitWhereInput = {
      ...(keyword
        ? {
            name: {
              contains: keyword,
              mode: Prisma.QueryMode.insensitive,
            },
          }
        : {}),
    };
    const totalItems = await this.inventoryRepository.client.unit.count({
      where,
    });
    const paging = this.paginationUtilService.paging({
      page,
      itemPerPage,
      totalItems,
    });
    const list = await this.inventoryRepository.client.unit.findMany({
      select: fieldsSelect,
      where,
      skip: paging.skip,
      take: paging.itemPerPage,
      orderBy: { createdAt: 'desc' },
    });

    return paging.format(list);
  }

  async findOne(id: string) {
    const unit = await this.inventoryRepository.client.unit.findUnique({
      where: { id },
      include: {
        _count: {
          select: { inventoryItems: true },
        },
      },
    });

    if (!unit) {
      throw new NotFoundException(`Unit with ID ${id} not found.`);
    }

    return unit;
  }

  async update(id: string, employeeId: string, dto: UpdateUnitDto) {
    await this.inventoryRepository.ensureActiveUnitExists(id);
    if (dto.name) {
      await this.inventoryRepository.ensureUnitNameAvailable(dto.name, id);
    }

    return this.inventoryTransactionService.runSerializable(async (tx) => {
      await this.assertActiveEmployee(tx, employeeId);
      const unit = await tx.unit.update({ where: { id }, data: dto });
      await this.inventoryAuditService.log(tx, {
        employeeId,
        actionType: 'INVENTORY_UNIT_UPDATED',
        details: { unitId: id, changes: dto },
      });
      return unit;
    });
  }

  async remove(id: string, employeeId: string) {
    await this.inventoryRepository.ensureActiveUnitExists(id);
    const linkedItemsCount =
      await this.inventoryRepository.client.inventoryItem.count({
        where: { unitId: id },
      });
    this.inventoryPolicy.assertCanDeleteUnit(linkedItemsCount);

    await this.inventoryTransactionService.runSerializable(async (tx) => {
      await this.assertActiveEmployee(tx, employeeId);
      await tx.unit.delete({ where: { id } });
      await this.inventoryAuditService.log(tx, {
        employeeId,
        actionType: 'INVENTORY_UNIT_DELETED',
        details: { unitId: id },
      });
    });

    return {
      success: true,
      message: `Unit #${id} has been deleted successfully`,
    };
  }

  private async assertActiveEmployee(tx: any, employeeId: string) {
    const employee = await tx.employee.findUnique({
      where: { id: employeeId },
      select: { isActive: true },
    });
    this.inventoryPolicy.assertActiveEmployee(employee);
  }
}
