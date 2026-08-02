import { randomUUID } from 'node:crypto';
import { Injectable, NotFoundException } from '@nestjs/common';
import { DiscountType } from '@prisma/client';
import { Decimal } from '@prisma/client/runtime/library';
import type {
  ExtendedPrismaTransactionClient,
  PromotionEventBase,
} from '../../common/types';
import { CreatePromotionDto } from './dto/create-promotion.dto';
import {
  GetActivePromotionsDto,
  SearchPromotionsDto,
} from './dto/promotion-common.dto';
import { UpdatePromotionDto } from './dto/update-promotion.dto';
import { PROMOTION_EVENTS } from './events/promotion.events';
import { PromotionEventsPublisher } from './events/promotion-events.publisher';
import { PromotionPolicyService } from './policies/promotion-policy.service';
import { PromotionsRepository } from './repositories/promotions.repository';
import { PromotionAuditService } from './services/promotion-audit.service';
import { PromotionQueryService } from './services/promotion-query.service';
import { PromotionTransactionService } from './services/promotion-transaction.service';

@Injectable()
export class PromotionsService {
  constructor(
    private readonly promotionsRepository: PromotionsRepository,
    private readonly promotionPolicy: PromotionPolicyService,
    private readonly promotionTransactionService: PromotionTransactionService,
    private readonly promotionAuditService: PromotionAuditService,
    private readonly promotionQueryService: PromotionQueryService,
    private readonly promotionEventsPublisher: PromotionEventsPublisher,
  ) {}

  async create(employeeId: string, dto: CreatePromotionDto) {
    const input = this.normalizeInput(dto);
    this.promotionPolicy.assertDateRangeValid(input.startDate, input.endDate);
    this.promotionPolicy.assertDiscountValueValid(input);

    const promotion = await this.promotionTransactionService.runSerializable(
      async (tx) => {
        await this.assertActiveEmployee(tx, employeeId);
        await this.promotionsRepository.ensureNameAvailable(
          input.name,
          undefined,
          tx,
        );

        const created = await tx.promotion.create({
          data: input,
        });
        await this.promotionAuditService.log(tx, {
          employeeId,
          actionType: 'PROMOTION_CREATED',
          details: this.serializePromotionDetails(created),
        });
        return created;
      },
    );

    this.emitPromotionEvent(PROMOTION_EVENTS.CREATED, promotion);
    return promotion;
  }

  findAll(query: SearchPromotionsDto) {
    return this.promotionQueryService.search(query);
  }

  findActive(query: GetActivePromotionsDto) {
    return this.promotionQueryService.findActive(query);
  }

  findOne(id: string) {
    return this.promotionQueryService.findOne(id);
  }

  async update(id: string, employeeId: string, dto: UpdatePromotionDto) {
    const promotion = await this.promotionTransactionService.runSerializable(
      async (tx) => {
        await this.assertActiveEmployee(tx, employeeId);
        const existing = await this.promotionsRepository.findActiveById(id, tx);
        if (!existing) {
          throw new NotFoundException(`Promotion with ID ${id} not found.`);
        }
        this.promotionPolicy.assertPromotionCanBeUpdated(existing);

        const usedInvoiceCount =
          await this.promotionsRepository.countInvoicesUsingPromotion(id, tx);
        const next = this.mergePromotionInput(existing, dto);

        this.promotionPolicy.assertDateRangeValid(next.startDate, next.endDate);
        this.promotionPolicy.assertDiscountValueValid(next);
        this.promotionPolicy.assertFinancialFieldsNotChangedWhenUsed({
          usedInvoiceCount,
          before: existing,
          after: next,
        });

        if (dto.name && dto.name !== existing.name) {
          await this.promotionsRepository.ensureNameAvailable(
            next.name,
            id,
            tx,
          );
        }

        const updated = await tx.promotion.update({
          where: { id },
          data: next,
        });
        await this.promotionAuditService.log(tx, {
          employeeId,
          actionType: 'PROMOTION_UPDATED',
          details: {
            promotionId: id,
            before: this.serializePromotionDetails(existing),
            after: this.serializePromotionDetails(updated),
          },
        });
        return updated;
      },
    );

    this.emitPromotionEvent(PROMOTION_EVENTS.UPDATED, promotion);
    return promotion;
  }

  async remove(id: string, employeeId: string) {
    const promotion = await this.promotionTransactionService.runSerializable(
      async (tx) => {
        await this.assertActiveEmployee(tx, employeeId);
        const existing =
          await this.promotionsRepository.findByIdIncludingDeleted(id, tx);
        this.promotionPolicy.assertPromotionCanBeDeleted(existing);

        const deleted = await tx.promotion.update({
          where: { id },
          data: { deletedAt: new Date() },
        });
        await this.promotionAuditService.log(tx, {
          employeeId,
          actionType: 'PROMOTION_DELETED',
          details: this.serializePromotionDetails(deleted),
        });
        return deleted;
      },
    );

    this.emitPromotionEvent(PROMOTION_EVENTS.DELETED, promotion);
    return {
      success: true,
      message: `Promotion #${id} has been deleted successfully`,
    };
  }

  async restore(id: string, employeeId: string) {
    const promotion = await this.promotionTransactionService.runSerializable(
      async (tx) => {
        await this.assertActiveEmployee(tx, employeeId);
        const existing =
          await this.promotionsRepository.findByIdIncludingDeleted(id, tx);
        this.promotionPolicy.assertPromotionCanBeRestored(existing);
        this.promotionPolicy.assertDateRangeValid(
          existing.startDate,
          existing.endDate,
        );
        await this.promotionsRepository.ensureNameAvailable(
          existing.name,
          id,
          tx,
        );

        const restored = await tx.promotion.update({
          where: { id },
          data: { deletedAt: null },
        });
        await this.promotionAuditService.log(tx, {
          employeeId,
          actionType: 'PROMOTION_RESTORED',
          details: this.serializePromotionDetails(restored),
        });
        return restored;
      },
    );

    this.emitPromotionEvent(PROMOTION_EVENTS.RESTORED, promotion);
    return promotion;
  }

  private normalizeInput(dto: CreatePromotionDto) {
    const discountValue = this.promotionPolicy.toPositiveDecimal(
      dto.discountValue,
      'discountValue',
    );
    const maxDiscount =
      dto.maxDiscount !== undefined && dto.maxDiscount !== null
        ? this.promotionPolicy.toPositiveDecimal(dto.maxDiscount, 'maxDiscount')
        : null;

    return {
      name: dto.name,
      startDate: dto.startDate,
      endDate: dto.endDate,
      discountType: dto.discountType,
      discountValue,
      maxDiscount,
    };
  }

  private mergePromotionInput(
    existing: {
      name: string;
      startDate: Date;
      endDate: Date;
      discountType: DiscountType;
      discountValue: Decimal;
      maxDiscount: Decimal | null;
    },
    dto: UpdatePromotionDto,
  ) {
    return {
      name: dto.name ?? existing.name,
      startDate: dto.startDate ?? existing.startDate,
      endDate: dto.endDate ?? existing.endDate,
      discountType: dto.discountType ?? existing.discountType,
      discountValue:
        dto.discountValue !== undefined
          ? this.promotionPolicy.toPositiveDecimal(
              dto.discountValue,
              'discountValue',
            )
          : existing.discountValue,
      maxDiscount:
        dto.maxDiscount === undefined
          ? existing.maxDiscount
          : dto.maxDiscount === null
            ? null
            : this.promotionPolicy.toPositiveDecimal(
                dto.maxDiscount,
                'maxDiscount',
              ),
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
    this.promotionPolicy.assertActiveEmployee(employee);
  }

  private serializePromotionDetails(promotion: {
    id: string;
    name: string;
    startDate: Date;
    endDate: Date;
    discountType: DiscountType;
    discountValue: Decimal;
    maxDiscount: Decimal | null;
    deletedAt?: Date | null;
  }) {
    return {
      promotionId: promotion.id,
      name: promotion.name,
      startDate: promotion.startDate.toISOString(),
      endDate: promotion.endDate.toISOString(),
      discountType: promotion.discountType,
      discountValue: promotion.discountValue.toString(),
      maxDiscount: promotion.maxDiscount?.toString() ?? null,
      deletedAt: promotion.deletedAt?.toISOString() ?? null,
    };
  }

  private emitPromotionEvent(
    eventName:
      | typeof PROMOTION_EVENTS.CREATED
      | typeof PROMOTION_EVENTS.UPDATED
      | typeof PROMOTION_EVENTS.DELETED
      | typeof PROMOTION_EVENTS.RESTORED,
    promotion: { id: string; name: string },
  ) {
    this.promotionEventsPublisher.emit(eventName, {
      ...this.createEventBase(promotion.id),
      name: promotion.name,
    });
  }

  private createEventBase(promotionId: string): PromotionEventBase {
    return {
      eventId: randomUUID(),
      occurredAt: new Date().toISOString(),
      promotionId,
    };
  }
}
