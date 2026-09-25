import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, PurchaseReceiptStatus } from '@prisma/client';
import type { ExtendedPrismaTransactionClient } from '../../../common/types';
import { PaginationUtilService } from '../../../common/utils/pagination-util/pagination-util.service';
import { CreateSupplierDto, GetSuppliersDto, UpdateSupplierDto } from '../dto';
import { InventoryPolicyService } from '../policies/inventory-policy.service';
import { InventoryRepository } from '../repositories/inventory.repository';
import { InventoryAuditService } from './inventory-audit.service';
import { InventoryTransactionService } from './inventory-transaction.service';

@Injectable()
export class SupplierService {
  constructor(
    private readonly inventoryRepository: InventoryRepository,
    private readonly inventoryPolicy: InventoryPolicyService,
    private readonly inventoryTransaction: InventoryTransactionService,
    private readonly inventoryAudit: InventoryAuditService,
    private readonly pagination: PaginationUtilService,
  ) {}

  create(employeeId: string, dto: CreateSupplierDto) {
    return this.inventoryTransaction.runSerializable(async (tx) => {
      await this.assertActiveEmployee(tx, employeeId);
      const code = this.normalizeCode(dto.code);
      await this.assertCodeAvailable(tx, code);
      const supplier = await tx.supplier.create({
        data: { ...dto, code },
      });
      await this.inventoryAudit.log(tx, {
        employeeId,
        actionType: 'INVENTORY_SUPPLIER_CREATED',
        details: { supplierId: supplier.id, code, name: supplier.name },
      });
      return supplier;
    });
  }

  async findAll({ page, itemPerPage, keyword }: GetSuppliersDto) {
    const where: Prisma.SupplierWhereInput = keyword
      ? {
          OR: [
            { code: { contains: keyword, mode: Prisma.QueryMode.insensitive } },
            { name: { contains: keyword, mode: Prisma.QueryMode.insensitive } },
            {
              contactName: {
                contains: keyword,
                mode: Prisma.QueryMode.insensitive,
              },
            },
          ],
        }
      : {};
    const totalItems = await this.inventoryRepository.client.supplier.count({
      where,
    });
    const paging = this.pagination.paging({ page, itemPerPage, totalItems });
    const suppliers = await this.inventoryRepository.client.supplier.findMany({
      where,
      skip: paging.skip,
      take: paging.itemPerPage,
      orderBy: [{ name: 'asc' }, { code: 'asc' }],
    });
    return paging.format(suppliers);
  }

  async findOne(id: string) {
    const supplier = await this.inventoryRepository.client.supplier.findUnique({
      where: { id },
      include: {
        _count: { select: { purchaseReceipts: true } },
      },
    });
    if (!supplier) {
      throw new NotFoundException(`Supplier with ID ${id} not found.`);
    }
    return supplier;
  }

  update(id: string, employeeId: string, dto: UpdateSupplierDto) {
    return this.inventoryTransaction.runSerializable(async (tx) => {
      await this.assertActiveEmployee(tx, employeeId);
      const existing = await tx.supplier.findFirst({
        where: { id, deletedAt: null },
        select: { id: true, code: true },
      });
      if (!existing) {
        throw new NotFoundException(`Supplier with ID ${id} not found.`);
      }

      const code = dto.code ? this.normalizeCode(dto.code) : existing.code;
      if (code !== existing.code) {
        await this.assertCodeAvailable(tx, code, id);
      }
      const supplier = await tx.supplier.update({
        where: { id },
        data: { ...dto, ...(dto.code ? { code } : {}) },
      });
      await this.inventoryAudit.log(tx, {
        employeeId,
        actionType: 'INVENTORY_SUPPLIER_UPDATED',
        details: { supplierId: id, changes: dto },
      });
      return supplier;
    });
  }

  async remove(id: string, employeeId: string) {
    await this.inventoryTransaction.runSerializable(async (tx) => {
      await this.assertActiveEmployee(tx, employeeId);
      const supplier = await tx.supplier.findFirst({
        where: { id, deletedAt: null },
        select: { id: true },
      });
      if (!supplier) {
        throw new NotFoundException(`Supplier with ID ${id} not found.`);
      }
      const draftReceipts = await tx.purchaseReceipt.count({
        where: { supplierId: id, status: PurchaseReceiptStatus.DRAFT },
      });
      if (draftReceipts > 0) {
        throw new ConflictException(
          'Cannot delete a supplier with draft purchase receipts.',
        );
      }
      await tx.supplier.update({
        where: { id },
        data: { deletedAt: new Date() },
      });
      await this.inventoryAudit.log(tx, {
        employeeId,
        actionType: 'INVENTORY_SUPPLIER_DELETED',
        details: { supplierId: id },
      });
    });
    return { success: true };
  }

  private normalizeCode(code: string) {
    return code.trim().toUpperCase();
  }

  private async assertCodeAvailable(
    tx: ExtendedPrismaTransactionClient,
    code: string,
    excludeId?: string,
  ) {
    const existing = await tx.supplier.findFirst({
      where: {
        code: { equals: code, mode: Prisma.QueryMode.insensitive },
        ...(excludeId ? { id: { not: excludeId } } : {}),
      },
      select: { id: true },
    });
    if (existing) {
      throw new ConflictException('Supplier code already exists.');
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
}
