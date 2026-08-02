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
export class PromotionsRepository {
  constructor(
    @Inject(PRISMA_SERVICE_TOKEN)
    private readonly prisma: ExtendedPrismaClient,
  ) {}

  get client() {
    return this.prisma;
  }

  findByIdIncludingDeleted(
    id: string,
    tx: ExtendedPrismaTransactionClient = this.prisma,
  ) {
    return tx.promotion.findFirst({
      where: {
        id,
        __includeDeleted: true,
      } as Prisma.PromotionWhereInput & { __includeDeleted: true },
    });
  }

  findActiveById(
    id: string,
    tx: ExtendedPrismaTransactionClient = this.prisma,
  ) {
    return tx.promotion.findUnique({
      where: { id },
    });
  }

  async getActiveByIdOrThrow(
    id: string,
    tx: ExtendedPrismaTransactionClient = this.prisma,
  ) {
    const promotion = await this.findActiveById(id, tx);
    if (!promotion) {
      throw new NotFoundException(`Promotion with ID ${id} not found.`);
    }
    return promotion;
  }

  async ensureNameAvailable(
    name: string,
    excludeId?: string,
    tx: ExtendedPrismaTransactionClient = this.prisma,
  ) {
    const existing = await tx.promotion.findFirst({
      where: {
        name: { equals: name, mode: Prisma.QueryMode.insensitive },
        deletedAt: null,
        ...(excludeId ? { id: { not: excludeId } } : {}),
      },
      select: { id: true },
    });

    if (existing) {
      throw new ConflictException('Promotion name already exists.');
    }
  }

  countInvoicesUsingPromotion(
    id: string,
    tx: ExtendedPrismaTransactionClient = this.prisma,
  ) {
    return tx.invoice.count({
      where: { promotionId: id },
    });
  }
}
