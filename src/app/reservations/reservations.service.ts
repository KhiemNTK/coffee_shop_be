import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  OnApplicationBootstrap,
  OnApplicationShutdown,
  UnauthorizedException,
} from '@nestjs/common';
import {
  Prisma,
  ReservationRequestStatus,
  ReservationStatus,
} from '@prisma/client';
import {
  PRISMA_SERVICE_TOKEN,
  type ExtendedPrismaClient,
} from '../../common/prisma/prisma.service';
import type { ExtendedPrismaTransactionClient } from '../../common/types';
import { PaginationUtilService } from '../../common/utils/pagination-util/pagination-util.service';
import { OrdersService } from '../orders/orders.service';
import {
  RESERVATION_NO_SHOW_GRACE_MS,
  RESERVATION_NO_SHOW_SCAN_INTERVAL_MS,
} from '../../common/consts/reservation';
import {
  ApproveReservationRequestDto,
  CancelReservationDto,
  CreatePublicReservationRequestDto,
  CreateReservationDto,
  GetReservationRequestsDto,
  GetReservationsDto,
  RejectReservationRequestDto,
  UpdateReservationDto,
} from './dto';

const MIN_RESERVATION_DURATION_MS = 15 * 60 * 1000;
const MAX_RESERVATION_DURATION_MS = 8 * 60 * 60 * 1000;
const MAX_PUBLIC_BOOKING_ADVANCE_MS = 30 * 24 * 60 * 60 * 1000;

@Injectable()
export class ReservationsService
  implements OnApplicationBootstrap, OnApplicationShutdown
{
  private readonly logger = new Logger(ReservationsService.name);
  private noShowTimer?: NodeJS.Timeout;

  constructor(
    @Inject(PRISMA_SERVICE_TOKEN)
    private readonly prisma: ExtendedPrismaClient,
    private readonly paginationUtil: PaginationUtilService,
    private readonly ordersService: OrdersService,
  ) {}

  onApplicationBootstrap() {
    void this.refreshNoShows();
    this.noShowTimer = setInterval(
      () => void this.refreshNoShows(),
      RESERVATION_NO_SHOW_SCAN_INTERVAL_MS,
    );
    this.noShowTimer.unref();
  }

  onApplicationShutdown() {
    if (this.noShowTimer) clearInterval(this.noShowTimer);
  }

  async createPublicRequest(dto: CreatePublicReservationRequestDto) {
    this.assertValidWindow(dto.startsAt, dto.endsAt, true);
    if (dto.startsAt.getTime() > Date.now() + MAX_PUBLIC_BOOKING_ADVANCE_MS) {
      throw new BadRequestException(
        'Reservations are limited to 30 days ahead.',
      );
    }
    const request = await this.prisma.reservationRequest.create({
      data: {
        customerName: dto.customerName,
        phoneNumber: dto.phoneNumber,
        startsAt: dto.startsAt,
        endsAt: dto.endsAt,
        guestCount: dto.guestCount,
        notes: dto.notes,
      },
      select: { id: true, status: true },
    });
    return { requestId: request.id, status: request.status };
  }

  async findRequests(query: GetReservationRequestsDto) {
    const where: Prisma.ReservationRequestWhereInput = query.status
      ? { status: query.status }
      : {
          status: ReservationRequestStatus.PENDING,
          startsAt: { gt: new Date() },
        };
    const totalItems = await this.prisma.reservationRequest.count({ where });
    const paging = this.paginationUtil.paging({ ...query, totalItems });
    const list = await this.prisma.reservationRequest.findMany({
      where,
      skip: paging.skip,
      take: paging.itemPerPage,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    });
    return paging.format(list);
  }

  async approveRequest(
    id: string,
    employeeId: string,
    { tableId }: ApproveReservationRequestDto,
  ) {
    try {
      return await this.prisma.$transaction(async (tx) => {
        await this.assertActiveEmployee(tx, employeeId);
        const request = await tx.reservationRequest.findUnique({
          where: { id },
        });
        if (!request) throw new NotFoundException('Request not found.');
        if (request.status !== ReservationRequestStatus.PENDING) {
          throw new ConflictException('Request has already been reviewed.');
        }
        this.assertValidWindow(request.startsAt, request.endsAt, true);
        await this.assertActiveTable(tx, tableId);

        const claimed = await tx.reservationRequest.updateMany({
          where: { id, status: ReservationRequestStatus.PENDING },
          data: {
            status: ReservationRequestStatus.APPROVED,
            reviewedAt: new Date(),
            reviewedById: employeeId,
          },
        });
        if (claimed.count !== 1) {
          throw new ConflictException('Request has already been reviewed.');
        }

        const reservation = await tx.reservation.create({
          data: {
            customerName: request.customerName,
            phoneNumber: request.phoneNumber,
            startsAt: request.startsAt,
            endsAt: request.endsAt,
            guestCount: request.guestCount,
            notes: request.notes,
            tableId,
            employeeId,
          },
          include: this.reservationInclude,
        });
        await tx.reservationRequest.update({
          where: { id },
          data: { reservationId: reservation.id },
        });
        await this.logAction(tx, employeeId, 'RESERVATION_REQUEST_APPROVED', {
          requestId: id,
          reservationId: reservation.id,
          tableId,
        });
        return reservation;
      });
    } catch (error) {
      this.rethrowScheduleConflict(error);
    }
  }

  async rejectRequest(
    id: string,
    employeeId: string,
    { reason }: RejectReservationRequestDto,
  ) {
    return this.prisma.$transaction(async (tx) => {
      await this.assertActiveEmployee(tx, employeeId);
      const request = await tx.reservationRequest.findUnique({
        where: { id },
        select: { id: true },
      });
      if (!request) throw new NotFoundException('Request not found.');
      const rejected = await tx.reservationRequest.updateMany({
        where: { id, status: ReservationRequestStatus.PENDING },
        data: {
          status: ReservationRequestStatus.REJECTED,
          rejectionReason: reason,
          reviewedAt: new Date(),
          reviewedById: employeeId,
        },
      });
      if (rejected.count !== 1) {
        throw new ConflictException('Request has already been reviewed.');
      }
      await this.logAction(tx, employeeId, 'RESERVATION_REQUEST_REJECTED', {
        requestId: id,
        reason,
      });
      return { requestId: id, status: ReservationRequestStatus.REJECTED };
    });
  }

  async create(employeeId: string, dto: CreateReservationDto) {
    this.assertValidWindow(dto.startsAt, dto.endsAt, true);

    try {
      return await this.prisma.$transaction(async (tx) => {
        await this.assertActiveEmployee(tx, employeeId);
        await this.assertActiveTable(tx, dto.tableId);

        const reservation = await tx.reservation.create({
          data: { ...dto, employeeId },
          include: this.reservationInclude,
        });
        await this.logAction(tx, employeeId, 'RESERVATION_CREATED', {
          reservationId: reservation.id,
          tableId: reservation.tableId,
          startsAt: reservation.startsAt.toISOString(),
          endsAt: reservation.endsAt.toISOString(),
        });
        return reservation;
      });
    } catch (error) {
      this.rethrowScheduleConflict(error);
    }
  }

  async findAll(query: GetReservationsDto) {
    const where: Prisma.ReservationWhereInput = {
      ...(query.status ? { status: query.status } : {}),
      ...(query.tableId ? { tableId: query.tableId } : {}),
      ...(query.phoneNumber ? { phoneNumber: query.phoneNumber } : {}),
      ...(query.startsFrom || query.startsTo
        ? {
            startsAt: {
              ...(query.startsFrom ? { gte: query.startsFrom } : {}),
              ...(query.startsTo ? { lte: query.startsTo } : {}),
            },
          }
        : {}),
    };
    const totalItems = await this.prisma.reservation.count({ where });
    const paging = this.paginationUtil.paging({ ...query, totalItems });
    const reservations = await this.prisma.reservation.findMany({
      where,
      skip: paging.skip,
      take: paging.itemPerPage,
      orderBy: [{ startsAt: 'asc' }, { id: 'asc' }],
      include: this.reservationInclude,
    });

    return paging.format(reservations);
  }

  async findOne(id: number) {
    const reservation = await this.prisma.reservation.findUnique({
      where: { id },
      include: this.reservationInclude,
    });
    if (!reservation) {
      throw new NotFoundException(`Reservation with ID ${id} not found.`);
    }
    return reservation;
  }

  async update(id: number, employeeId: string, dto: UpdateReservationDto) {
    try {
      return await this.prisma.$transaction(async (tx) => {
        await this.assertActiveEmployee(tx, employeeId);
        const existing = await tx.reservation.findUnique({ where: { id } });
        if (!existing) {
          throw new NotFoundException(`Reservation with ID ${id} not found.`);
        }
        if (existing.status !== ReservationStatus.PENDING) {
          throw new ConflictException(
            'Only pending reservations can be updated.',
          );
        }

        const startsAt = dto.startsAt ?? existing.startsAt;
        const endsAt = dto.endsAt ?? existing.endsAt;
        this.assertValidWindow(startsAt, endsAt, false);

        if (dto.tableId && dto.tableId !== existing.tableId) {
          await this.assertActiveTable(tx, dto.tableId);
        }

        const updated = await tx.reservation.updateMany({
          where: { id, status: ReservationStatus.PENDING },
          data: dto,
        });
        if (updated.count !== 1) {
          throw new ConflictException('Reservation status has changed.');
        }

        const reservation = await tx.reservation.findUniqueOrThrow({
          where: { id },
          include: this.reservationInclude,
        });
        await this.logAction(tx, employeeId, 'RESERVATION_UPDATED', {
          reservationId: id,
          changes: this.toAuditChanges(dto),
        });
        return reservation;
      });
    } catch (error) {
      this.rethrowScheduleConflict(error);
    }
  }

  async cancel(
    id: number,
    employeeId: string,
    { reason }: CancelReservationDto,
  ) {
    return this.prisma.$transaction(async (tx) => {
      await this.assertActiveEmployee(tx, employeeId);
      const existing = await tx.reservation.findUnique({
        where: { id },
        select: { id: true, status: true },
      });
      if (!existing) {
        throw new NotFoundException(`Reservation with ID ${id} not found.`);
      }
      if (existing.status !== ReservationStatus.PENDING) {
        throw new ConflictException(
          'Only pending reservations can be cancelled.',
        );
      }

      const cancelledAt = new Date();
      const result = await tx.reservation.updateMany({
        where: { id, status: ReservationStatus.PENDING },
        data: {
          status: ReservationStatus.CANCELLED,
          cancelledAt,
          cancellationReason: reason,
        },
      });
      if (result.count !== 1) {
        throw new ConflictException('Reservation status has changed.');
      }

      const reservation = await tx.reservation.findUniqueOrThrow({
        where: { id },
        include: this.reservationInclude,
      });
      await this.logAction(tx, employeeId, 'RESERVATION_CANCELLED', {
        reservationId: id,
        reason,
      });
      return reservation;
    });
  }

  checkIn(id: number, employeeId: string) {
    return this.ordersService.checkInReservation(id, employeeId);
  }

  async markOverdueNoShows(now = new Date()) {
    const cutoff = new Date(now.getTime() - RESERVATION_NO_SHOW_GRACE_MS);
    const result = await this.prisma.reservation.updateMany({
      where: {
        status: ReservationStatus.PENDING,
        startsAt: { lte: cutoff },
      },
      data: {
        status: ReservationStatus.NO_SHOW,
        noShowAt: now,
      },
    });
    return result.count;
  }

  async markExpiredPublicRequests(now = new Date()) {
    const result = await this.prisma.reservationRequest.updateMany({
      where: {
        status: ReservationRequestStatus.PENDING,
        startsAt: { lte: now },
      },
      data: {
        status: ReservationRequestStatus.EXPIRED,
        reviewedAt: now,
      },
    });
    return result.count;
  }

  private readonly reservationInclude = {
    table: { select: { id: true, name: true, status: true } },
    employee: { select: { id: true, fullName: true } },
    orderSession: {
      select: { id: true, sessionStatus: true, createdAt: true },
    },
  } as const;

  private assertValidWindow(
    startsAt: Date,
    endsAt: Date,
    requireFutureStart: boolean,
  ) {
    const duration = endsAt.getTime() - startsAt.getTime();
    if (requireFutureStart && startsAt <= new Date()) {
      throw new BadRequestException('startsAt must be in the future.');
    }
    if (duration < MIN_RESERVATION_DURATION_MS) {
      throw new BadRequestException(
        'A reservation must be at least 15 minutes long.',
      );
    }
    if (duration > MAX_RESERVATION_DURATION_MS) {
      throw new BadRequestException(
        'A reservation cannot be longer than 8 hours.',
      );
    }
    if (endsAt <= new Date()) {
      throw new BadRequestException('endsAt must be in the future.');
    }
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

  private async assertActiveTable(
    tx: ExtendedPrismaTransactionClient,
    tableId: string,
  ) {
    const table = await tx.diningTable.findFirst({
      where: { id: tableId, deletedAt: null },
      select: { id: true },
    });
    if (!table) {
      throw new NotFoundException(`Dining table with ID ${tableId} not found.`);
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

  private toAuditChanges(dto: UpdateReservationDto) {
    return Object.fromEntries(
      Object.entries(dto).map(([key, value]) => [
        key,
        value instanceof Date ? value.toISOString() : value,
      ]),
    );
  }

  private rethrowScheduleConflict(error: unknown): never {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      (error.code === 'P2002' || error.code === 'P2004')
    ) {
      throw new ConflictException(
        'The dining table already has an overlapping reservation.',
      );
    }
    throw error;
  }

  private async refreshNoShows() {
    try {
      const [count, expired] = await Promise.all([
        this.markOverdueNoShows(),
        this.markExpiredPublicRequests(),
      ]);
      if (count > 0) {
        this.logger.log(`Marked ${count} overdue reservations as no-show.`);
      }
      if (expired > 0) {
        this.logger.log(`Expired ${expired} public reservation requests.`);
      }
    } catch (error) {
      this.logger.error(
        'Failed to mark overdue reservations as no-show.',
        error instanceof Error ? error.stack : String(error),
      );
    }
  }
}
