import {
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { ExtendedPrismaClient } from '../../../common/prisma/prisma.service';
import { PRISMA_SERVICE_TOKEN } from '../../../common/prisma/prisma.service';
import type { ExtendedPrismaTransactionClient } from '../../../common/types';

@Injectable()
export class InventoryRepository {
  constructor(
    @Inject(PRISMA_SERVICE_TOKEN)
    private readonly prisma: ExtendedPrismaClient,
  ) {}

  get client() {
    return this.prisma;
  }

  async ensureActiveCategoryExists(
    id: string,
    tx: ExtendedPrismaTransactionClient = this.prisma,
  ) {
    const category = await tx.inventoryCategory.findUnique({
      where: { id },
      select: { id: true },
    });

    if (!category) {
      throw new NotFoundException(
        `Inventory category with ID ${id} not found.`,
      );
    }

    return category;
  }

  async ensureActiveUnitExists(
    id: string,
    tx: ExtendedPrismaTransactionClient = this.prisma,
  ) {
    const unit = await tx.unit.findUnique({
      where: { id },
      select: { id: true },
    });

    if (!unit) {
      throw new NotFoundException(`Unit with ID ${id} not found.`);
    }

    return unit;
  }

  async ensureActiveItemExists(
    id: string,
    tx: ExtendedPrismaTransactionClient = this.prisma,
  ) {
    const item = await tx.inventoryItem.findUnique({
      where: { id },
      select: {
        id: true,
        stock: true,
        categoryId: true,
        unitId: true,
      },
    });

    if (!item) {
      throw new NotFoundException(`Inventory item with ID ${id} not found.`);
    }

    return item;
  }

  async ensureCategoryNameAvailable(name: string, excludeId?: string) {
    const existing = await this.prisma.inventoryCategory.findFirst({
      where: {
        name: { equals: name, mode: Prisma.QueryMode.insensitive },
        ...(excludeId ? { id: { not: excludeId } } : {}),
      },
      select: { id: true },
    });

    if (existing) {
      throw new ConflictException('Inventory category name already exists.');
    }
  }

  async ensureUnitNameAvailable(name: string, excludeId?: string) {
    const existing = await this.prisma.unit.findFirst({
      where: {
        name: { equals: name, mode: Prisma.QueryMode.insensitive },
        ...(excludeId ? { id: { not: excludeId } } : {}),
      },
      select: { id: true },
    });

    if (existing) {
      throw new ConflictException('Unit name already exists.');
    }
  }

  async ensureItemNameAvailable({
    name,
    categoryId,
    excludeId,
    tx = this.prisma,
  }: {
    name: string;
    categoryId: string;
    excludeId?: string;
    tx?: ExtendedPrismaTransactionClient;
  }) {
    const existing = await tx.inventoryItem.findFirst({
      where: {
        name: { equals: name, mode: Prisma.QueryMode.insensitive },
        categoryId,
        ...(excludeId ? { id: { not: excludeId } } : {}),
      },
      select: { id: true },
    });

    if (existing) {
      throw new ConflictException(
        'Inventory item name already exists in this category.',
      );
    }
  }
}
