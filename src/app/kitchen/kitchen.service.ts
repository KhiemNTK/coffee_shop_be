import {
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { Prisma, PrintDeviceType, ServeStatus } from '@prisma/client';
import {
  PRISMA_SERVICE_TOKEN,
  type ExtendedPrismaClient,
} from '../../common/prisma/prisma.service';
import { runSerializableTransaction } from '../../common/prisma/transaction.util';
import type {
  ExtendedPrismaTransactionClient,
  KitchenTicketState,
} from '../../common/types';
import { PaginationUtilService } from '../../common/utils/pagination-util/pagination-util.service';
import {
  CreateKitchenStationDto,
  GetKitchenStationsDto,
  GetKitchenTicketsDto,
  UpdateKitchenStationDto,
} from './dto';

const KITCHEN_TICKET_INCLUDE = {
  station: { select: { id: true, code: true, name: true } },
  orderSession: { select: { table: { select: { id: true, name: true } } } },
  items: {
    orderBy: { createdAt: 'asc' as const },
    include: {
      orderItem: {
        select: {
          serveStatus: true,
          orderSession: {
            select: { table: { select: { id: true, name: true } } },
          },
        },
      },
    },
  },
} satisfies Prisma.KitchenTicketInclude;

type KitchenTicketDetails = Prisma.KitchenTicketGetPayload<{
  include: typeof KITCHEN_TICKET_INCLUDE;
}>;

@Injectable()
export class KitchenService {
  constructor(
    @Inject(PRISMA_SERVICE_TOKEN)
    private readonly prisma: ExtendedPrismaClient,
    private readonly pagination: PaginationUtilService,
  ) {}

  createStation(employeeId: string, dto: CreateKitchenStationDto) {
    return this.transaction(async (tx) => {
      await this.assertActiveEmployee(tx, employeeId);
      if (dto.printDeviceId) {
        await this.assertKitchenDevice(tx, dto.printDeviceId);
      }
      const station = await tx.kitchenStation.create({
        data: {
          code: dto.code.toUpperCase(),
          name: dto.name,
          prepSlaSeconds: dto.prepSlaSeconds,
          printDeviceId: dto.printDeviceId,
        },
        include: this.stationInclude,
      });
      await this.audit(tx, employeeId, 'KITCHEN_STATION_CREATED', {
        kitchenStationId: station.id,
        code: station.code,
      });
      return station;
    });
  }

  async getStations(query: GetKitchenStationsDto) {
    const where: Prisma.KitchenStationWhereInput = {
      deletedAt: null,
      ...(query.isActive === undefined ? {} : { isActive: query.isActive }),
    };
    const totalItems = await this.prisma.kitchenStation.count({ where });
    const paging = this.pagination.paging({ ...query, totalItems });
    const stations = await this.prisma.kitchenStation.findMany({
      where,
      skip: paging.skip,
      take: paging.itemPerPage,
      orderBy: [{ name: 'asc' }, { id: 'asc' }],
      include: this.stationInclude,
    });
    return paging.format(stations);
  }

  async getStation(id: string) {
    const station = await this.prisma.kitchenStation.findFirst({
      where: { id, deletedAt: null },
      include: this.stationInclude,
    });
    if (!station)
      throw new NotFoundException(`Kitchen station ${id} not found.`);
    return station;
  }

  updateStation(id: string, employeeId: string, dto: UpdateKitchenStationDto) {
    return this.transaction(async (tx) => {
      await this.assertActiveEmployee(tx, employeeId);
      const station = await tx.kitchenStation.findFirst({
        where: { id, deletedAt: null },
      });
      if (!station)
        throw new NotFoundException(`Kitchen station ${id} not found.`);
      if (dto.printDeviceId) {
        await this.assertKitchenDevice(tx, dto.printDeviceId);
      }
      if (dto.isActive === false && station.isActive) {
        await this.assertNoActiveTickets(tx, id);
      }

      const updated = await tx.kitchenStation.update({
        where: { id },
        data: {
          code: dto.code?.toUpperCase(),
          name: dto.name,
          prepSlaSeconds: dto.prepSlaSeconds,
          printDeviceId: dto.printDeviceId,
          isActive: dto.isActive,
        },
        include: this.stationInclude,
      });
      await this.audit(tx, employeeId, 'KITCHEN_STATION_UPDATED', {
        kitchenStationId: id,
        changes: this.jsonObject(dto),
      });
      return updated;
    });
  }

  async deleteStation(id: string, employeeId: string) {
    await this.transaction(async (tx) => {
      await this.assertActiveEmployee(tx, employeeId);
      const station = await tx.kitchenStation.findFirst({
        where: { id, deletedAt: null },
        select: { id: true },
      });
      if (!station)
        throw new NotFoundException(`Kitchen station ${id} not found.`);
      await this.assertNoActiveTickets(tx, id);

      const assignedItems = await tx.menuItem.count({
        where: { kitchenStationId: id, deletedAt: null },
      });
      if (assignedItems > 0) {
        throw new ConflictException(
          'Unassign active menu items before deleting this kitchen station.',
        );
      }
      await tx.kitchenStation.update({
        where: { id },
        data: { deletedAt: new Date(), isActive: false, printDeviceId: null },
      });
      await this.audit(tx, employeeId, 'KITCHEN_STATION_DELETED', {
        kitchenStationId: id,
      });
    });
    return { success: true };
  }

  async getTickets(query: GetKitchenTicketsDto) {
    const where = this.ticketWhere(query);
    const totalItems = await this.prisma.kitchenTicket.count({ where });
    const paging = this.pagination.paging({ ...query, totalItems });
    const tickets = await this.prisma.kitchenTicket.findMany({
      where,
      skip: paging.skip,
      take: paging.itemPerPage,
      orderBy: [{ dueAt: 'asc' }, { sequence: 'asc' }],
      include: KITCHEN_TICKET_INCLUDE,
    });
    return paging.format(tickets.map((ticket) => this.ticketView(ticket)));
  }

  async getTicket(id: string) {
    const ticket = await this.prisma.kitchenTicket.findUnique({
      where: { id },
      include: KITCHEN_TICKET_INCLUDE,
    });
    if (!ticket) throw new NotFoundException(`Kitchen ticket ${id} not found.`);
    return this.ticketView(ticket);
  }

  private ticketWhere(
    query: GetKitchenTicketsDto,
  ): Prisma.KitchenTicketWhereInput {
    return {
      ...(query.stationId ? { stationId: query.stationId } : {}),
      ...(query.includeCompleted
        ? {}
        : {
            items: {
              some: {
                orderItem: {
                  serveStatus: {
                    in: [ServeStatus.PENDING, ServeStatus.COOKING],
                  },
                },
              },
            },
          }),
    };
  }

  private ticketView(ticket: KitchenTicketDetails) {
    const statuses = ticket.items.map((item) => item.orderItem.serveStatus);
    const state = this.ticketState(statuses);
    return {
      id: ticket.id,
      sequence: ticket.sequence,
      ticketNumber: `${ticket.station.code}-${ticket.sequence}`,
      state,
      isOverdue:
        (state === 'PENDING' || state === 'IN_PROGRESS') &&
        ticket.dueAt.getTime() < Date.now(),
      dueAt: ticket.dueAt,
      createdAt: ticket.createdAt,
      station: ticket.station,
      orderSessionId: ticket.orderSessionId,
      table: ticket.orderSession.table,
      items: ticket.items.map((item) => ({
        id: item.id,
        orderItemId: item.orderItemId,
        itemName: item.itemName,
        quantity: item.quantity,
        note: item.note,
        serveStatus: item.orderItem.serveStatus,
        currentTable: item.orderItem.orderSession.table,
      })),
    };
  }

  private ticketState(statuses: ServeStatus[]): KitchenTicketState {
    if (statuses.every((status) => status === ServeStatus.CANCELLED)) {
      return 'CANCELLED';
    }
    if (
      statuses.every(
        (status) =>
          status === ServeStatus.READY ||
          status === ServeStatus.SERVED ||
          status === ServeStatus.CANCELLED,
      )
    ) {
      return 'COMPLETED';
    }
    if (
      statuses.some(
        (status) =>
          status === ServeStatus.COOKING ||
          status === ServeStatus.READY ||
          status === ServeStatus.SERVED,
      )
    ) {
      return 'IN_PROGRESS';
    }
    return 'PENDING';
  }

  private readonly stationInclude = {
    printDevice: {
      select: { id: true, name: true, status: true, isActive: true },
    },
    _count: { select: { menuItems: true, tickets: true } },
  } as const;

  private async assertNoActiveTickets(
    tx: ExtendedPrismaTransactionClient,
    stationId: string,
  ) {
    const activeTickets = await tx.kitchenTicket.count({
      where: {
        stationId,
        items: {
          some: {
            orderItem: {
              serveStatus: { in: [ServeStatus.PENDING, ServeStatus.COOKING] },
            },
          },
        },
      },
    });
    if (activeTickets > 0) {
      throw new ConflictException(
        'Kitchen station still has pending or cooking tickets.',
      );
    }
  }

  private async assertKitchenDevice(
    tx: ExtendedPrismaTransactionClient,
    printDeviceId: string,
  ) {
    const device = await tx.printDevice.findFirst({
      where: {
        id: printDeviceId,
        type: PrintDeviceType.KITCHEN,
        isActive: true,
        deletedAt: null,
      },
      select: { id: true },
    });
    if (!device) {
      throw new ConflictException(
        'An active kitchen print device is required.',
      );
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

  private audit(
    tx: ExtendedPrismaTransactionClient,
    employeeId: string,
    actionType: string,
    details: Prisma.InputJsonObject,
  ) {
    return tx.actionLog.create({ data: { employeeId, actionType, details } });
  }

  private jsonObject(value: object): Prisma.InputJsonObject {
    return Object.fromEntries(
      Object.entries(value).filter(([, item]) => item !== undefined),
    );
  }

  private transaction<T>(
    callback: (tx: ExtendedPrismaTransactionClient) => Promise<T>,
  ) {
    return runSerializableTransaction(this.prisma, callback, {
      loggerContext: 'Kitchen transaction',
      retryUniqueViolations: true,
    });
  }
}
