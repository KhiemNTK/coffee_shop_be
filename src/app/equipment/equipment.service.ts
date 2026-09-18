import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { EquipmentStatus, Prisma } from '@prisma/client';
import {
  PRISMA_SERVICE_TOKEN,
  type ExtendedPrismaClient,
} from '../../common/prisma/prisma.service';
import type { ExtendedPrismaTransactionClient } from '../../common/types';
import { PaginationUtilService } from '../../common/utils/pagination-util/pagination-util.service';
import {
  CreateEquipmentDto,
  GetEquipmentDto,
  GetEquipmentEventsDto,
  TransitionEquipmentDto,
  UpdateEquipmentDto,
} from './dto';

const ALLOWED_TRANSITIONS: Record<EquipmentStatus, EquipmentStatus[]> = {
  IN_USE: [
    EquipmentStatus.MAINTENANCE,
    EquipmentStatus.BROKEN,
    EquipmentStatus.LIQUIDATED,
  ],
  MAINTENANCE: [
    EquipmentStatus.IN_USE,
    EquipmentStatus.BROKEN,
    EquipmentStatus.LIQUIDATED,
  ],
  BROKEN: [EquipmentStatus.MAINTENANCE, EquipmentStatus.LIQUIDATED],
  LIQUIDATED: [],
};
const MAX_EQUIPMENT_AMOUNT = new Prisma.Decimal('9999999999999999.99');

@Injectable()
export class EquipmentService {
  constructor(
    @Inject(PRISMA_SERVICE_TOKEN)
    private readonly prisma: ExtendedPrismaClient,
    private readonly paginationUtil: PaginationUtilService,
  ) {}

  async create(employeeId: string, dto: CreateEquipmentDto) {
    this.assertEquipmentDates(dto.purchaseDate, dto.warrantyExpiresAt);
    const unitPrice = new Prisma.Decimal(dto.unitPrice);
    const totalAmount = this.calculateTotal(unitPrice, dto.quantity);

    try {
      return await this.prisma.$transaction(async (tx) => {
        await this.assertActiveEmployee(tx, employeeId);
        const equipment = await tx.equipment.create({
          data: {
            ...dto,
            unitPrice,
            totalAmount,
            employeeId,
          },
          include: this.equipmentInclude,
        });
        await tx.equipmentLifecycleEvent.create({
          data: {
            equipmentId: equipment.id,
            employeeId,
            toStatus: EquipmentStatus.IN_USE,
            reason: 'Equipment registered',
          },
        });
        await this.logAction(tx, employeeId, 'EQUIPMENT_CREATED', {
          equipmentId: equipment.id,
          assetCode: equipment.assetCode,
          totalAmount: equipment.totalAmount.toString(),
        });
        return equipment;
      });
    } catch (error) {
      this.rethrowUniqueConflict(error);
    }
  }

  async findAll(query: GetEquipmentDto) {
    const where: Prisma.EquipmentWhereInput = {
      deletedAt: null,
      ...(query.status ? { status: query.status } : {}),
      ...(query.maintenanceDueBefore
        ? { nextMaintenanceAt: { lte: query.maintenanceDueBefore } }
        : {}),
      ...(query.keyword
        ? {
            OR: [
              {
                assetCode: {
                  contains: query.keyword,
                  mode: Prisma.QueryMode.insensitive,
                },
              },
              {
                serialNumber: {
                  contains: query.keyword,
                  mode: Prisma.QueryMode.insensitive,
                },
              },
              {
                name: {
                  contains: query.keyword,
                  mode: Prisma.QueryMode.insensitive,
                },
              },
            ],
          }
        : {}),
    };
    const totalItems = await this.prisma.equipment.count({ where });
    const paging = this.paginationUtil.paging({ ...query, totalItems });
    const equipment = await this.prisma.equipment.findMany({
      where,
      skip: paging.skip,
      take: paging.itemPerPage,
      orderBy: [{ status: 'asc' }, { name: 'asc' }, { id: 'asc' }],
      include: this.equipmentInclude,
    });
    return paging.format(equipment);
  }

  async findOne(id: string) {
    const equipment = await this.prisma.equipment.findFirst({
      where: { id, deletedAt: null },
      include: this.equipmentInclude,
    });
    if (!equipment) {
      throw new NotFoundException(`Equipment with ID ${id} not found.`);
    }
    return equipment;
  }

  async findEvents(id: string, query: GetEquipmentEventsDto) {
    const equipment = await this.prisma.equipment.findFirst({
      where: { id, deletedAt: null },
      select: { id: true },
    });
    if (!equipment) {
      throw new NotFoundException(`Equipment with ID ${id} not found.`);
    }
    const where = { equipmentId: id };
    const totalItems = await this.prisma.equipmentLifecycleEvent.count({
      where,
    });
    const paging = this.paginationUtil.paging({ ...query, totalItems });
    const events = await this.prisma.equipmentLifecycleEvent.findMany({
      where,
      skip: paging.skip,
      take: paging.itemPerPage,
      orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
      include: {
        employee: { select: { id: true, fullName: true } },
      },
    });
    return paging.format(events);
  }

  async update(id: string, employeeId: string, dto: UpdateEquipmentDto) {
    try {
      return await this.prisma.$transaction(async (tx) => {
        await this.assertActiveEmployee(tx, employeeId);
        const existing = await tx.equipment.findFirst({
          where: { id, deletedAt: null },
        });
        if (!existing) {
          throw new NotFoundException(`Equipment with ID ${id} not found.`);
        }
        if (existing.status === EquipmentStatus.LIQUIDATED) {
          throw new ConflictException('Liquidated equipment is immutable.');
        }

        const purchaseDate = dto.purchaseDate ?? existing.purchaseDate;
        const warrantyExpiresAt =
          dto.warrantyExpiresAt === undefined
            ? existing.warrantyExpiresAt
            : dto.warrantyExpiresAt;
        this.assertEquipmentDates(purchaseDate, warrantyExpiresAt);

        const quantity = dto.quantity ?? existing.quantity;
        const unitPrice =
          dto.unitPrice === undefined
            ? existing.unitPrice
            : new Prisma.Decimal(dto.unitPrice);
        const equipment = await tx.equipment.update({
          where: { id },
          data: {
            ...dto,
            unitPrice,
            totalAmount: this.calculateTotal(unitPrice, quantity),
          },
          include: this.equipmentInclude,
        });
        await this.logAction(tx, employeeId, 'EQUIPMENT_UPDATED', {
          equipmentId: id,
          changes: this.toAuditChanges(dto),
        });
        return equipment;
      });
    } catch (error) {
      this.rethrowUniqueConflict(error);
    }
  }

  async transition(
    id: string,
    employeeId: string,
    dto: TransitionEquipmentDto,
  ) {
    const occurredAt = dto.occurredAt ?? new Date();
    if (occurredAt > new Date()) {
      throw new BadRequestException('occurredAt cannot be in the future.');
    }
    const cost = new Prisma.Decimal(dto.cost);

    return this.prisma.$transaction(async (tx) => {
      await this.assertActiveEmployee(tx, employeeId);
      const existing = await tx.equipment.findFirst({
        where: { id, deletedAt: null },
      });
      if (!existing) {
        throw new NotFoundException(`Equipment with ID ${id} not found.`);
      }
      if (!ALLOWED_TRANSITIONS[existing.status].includes(dto.status)) {
        throw new ConflictException(
          `Cannot transition equipment from ${existing.status} to ${dto.status}.`,
        );
      }
      if (occurredAt < existing.purchaseDate) {
        throw new BadRequestException(
          'occurredAt cannot be before purchaseDate.',
        );
      }

      const updated = await tx.equipment.updateMany({
        where: { id, status: existing.status, deletedAt: null },
        data: {
          status: dto.status,
          nextMaintenanceAt:
            dto.status === EquipmentStatus.LIQUIDATED
              ? null
              : dto.nextMaintenanceAt,
          liquidatedAt:
            dto.status === EquipmentStatus.LIQUIDATED ? occurredAt : null,
        },
      });
      if (updated.count !== 1) {
        throw new ConflictException('Equipment status has changed.');
      }

      const event = await tx.equipmentLifecycleEvent.create({
        data: {
          equipmentId: id,
          employeeId,
          fromStatus: existing.status,
          toStatus: dto.status,
          reason: dto.reason,
          cost,
          occurredAt,
        },
        include: {
          employee: { select: { id: true, fullName: true } },
        },
      });
      await this.logAction(tx, employeeId, 'EQUIPMENT_STATUS_CHANGED', {
        equipmentId: id,
        fromStatus: existing.status,
        toStatus: dto.status,
        reason: dto.reason,
        cost: cost.toString(),
      });
      return {
        equipment: await tx.equipment.findUniqueOrThrow({
          where: { id },
          include: this.equipmentInclude,
        }),
        event,
      };
    });
  }

  private readonly equipmentInclude = {
    employee: { select: { id: true, fullName: true } },
    cashTransaction: {
      select: { id: true, amount: true, transactionDate: true },
    },
    _count: { select: { lifecycleEvents: true } },
  } as const;

  private assertEquipmentDates(
    purchaseDate: Date,
    warrantyExpiresAt?: Date | null,
  ) {
    if (purchaseDate > new Date()) {
      throw new BadRequestException('purchaseDate cannot be in the future.');
    }
    if (warrantyExpiresAt && warrantyExpiresAt < purchaseDate) {
      throw new BadRequestException(
        'warrantyExpiresAt cannot be before purchaseDate.',
      );
    }
  }

  private calculateTotal(unitPrice: Prisma.Decimal, quantity: number) {
    const total = unitPrice.mul(quantity);
    if (total.greaterThan(MAX_EQUIPMENT_AMOUNT)) {
      throw new BadRequestException('Equipment totalAmount is too large.');
    }
    return total;
  }

  private async assertActiveEmployee(
    tx: ExtendedPrismaTransactionClient,
    employeeId: string,
  ) {
    const employee = await tx.employee.findFirst({
      where: { id: employeeId, isActive: true, deletedAt: null },
      select: { id: true },
    });
    if (!employee) {
      throw new UnauthorizedException('Employee is inactive or not found.');
    }
  }

  private async logAction(
    tx: ExtendedPrismaTransactionClient,
    employeeId: string,
    actionType: string,
    details: Prisma.InputJsonObject,
  ) {
    await tx.actionLog.create({
      data: { employeeId, actionType, details },
    });
  }

  private toAuditChanges(dto: UpdateEquipmentDto) {
    return Object.fromEntries(
      Object.entries(dto).map(([key, value]) => [
        key,
        value instanceof Date ? value.toISOString() : value,
      ]),
    );
  }

  private rethrowUniqueConflict(error: unknown): never {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === 'P2002'
    ) {
      throw new ConflictException(
        'Equipment assetCode or serialNumber already exists.',
      );
    }
    throw error;
  }
}
