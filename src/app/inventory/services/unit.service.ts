import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { ExtendedPrismaTransactionClient } from '../../../common/types';
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
    const fieldsSelect = this.queryUtilService.convertFieldsSelectOption<any>(
      select,
      'Unit',
    );
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
      const existing = await tx.unit.findFirst({
        where: { id, deletedAt: null },
        select: { name: true },
      });
      if (!existing)
        throw new NotFoundException(`Unit with ID ${id} not found.`);
      if (dto.name !== undefined && dto.name !== existing.name) {
        // Historical items must retain their measurement meaning after soft deletion.
        const [usage] = await tx.$queryRaw<{ used: boolean }[]>`
          SELECT EXISTS(SELECT 1 FROM "InventoryItem" WHERE "unitId" = ${id}) AS used
        `;
        if (usage.used) {
          throw new ConflictException({
            code: 'INVENTORY_UNIT_IN_USE',
            message: 'A unit used by inventory items cannot be renamed.',
          });
        }
      }
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
    await this.inventoryTransactionService.runSerializable(async (tx) => {
      await this.assertActiveEmployee(tx, employeeId);
      await this.inventoryRepository.ensureActiveUnitExists(id, tx);
      const linkedItemsCount = await tx.inventoryItem.count({
        where: { unitId: id },
      });
      this.inventoryPolicy.assertCanDeleteUnit(linkedItemsCount);

      await tx.unit.update({
        where: { id },
        data: { deletedAt: new Date() },
      });
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
}
