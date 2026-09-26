import { randomUUID } from 'node:crypto';
import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import {
  Prisma,
  ReservationStatus,
  ServeStatus,
  SessionStatus,
  TableStatus,
} from '@prisma/client';
import {
  AddOrderItemsDto,
  CancelOrderItemDto,
  GetHandoffItemsDto,
  MergeDiningTableDto,
  SplitOrderSessionDto,
  TransferDiningTableDto,
  UpdateOrderItemStatusDto,
} from './dto';
import {
  type ExtendedPrismaClient,
  PRISMA_SERVICE_TOKEN,
} from '../../common/prisma/prisma.service';
import { ORDER_EVENTS } from './events/order.events';
import { OrderPolicyService } from './order-policy.service';
import type {
  ExtendedPrismaTransactionClient,
  OpenSessionInput,
  OrderEventBase,
  SplittableOrderItem,
} from '../../common/types';
import { InventoryConsumptionService } from '../inventory/services/inventory-consumption.service';
import {
  RESERVATION_CHECK_IN_EARLY_MS,
  RESERVATION_NO_SHOW_GRACE_MS,
} from '../../common/consts/reservation';
import { CashierShiftLedgerService } from '../cashier-shifts/cashier-shift-ledger.service';
import { OutboxService } from '../durable/outbox.service';
import { runSerializableTransaction as executeSerializableTransaction } from '../../common/prisma/transaction.util';
import { KitchenRoutingService } from '../kitchen/kitchen-routing.service';
import { PaginationUtilService } from '../../common/utils/pagination-util/pagination-util.service';

@Injectable()
export class OrdersService {
  private readonly logger = new Logger(OrdersService.name);

  constructor(
    @Inject(PRISMA_SERVICE_TOKEN)
    private readonly prisma: ExtendedPrismaClient,
    private readonly outbox: OutboxService,
    private readonly orderPolicy: OrderPolicyService,
    private readonly inventoryConsumption: InventoryConsumptionService,
    private readonly cashierShiftLedger: CashierShiftLedgerService,
    private readonly kitchenRouting: KitchenRoutingService,
    private readonly pagination: PaginationUtilService,
  ) {}

  private readonly orderSessionInclude = {
    table: true,
    employee: {
      select: {
        id: true,
        fullName: true,
      },
    },
    shift: true,
    orderItems: {
      include: {
        menuItem: true,
      },
      orderBy: {
        createdAt: 'asc' as const,
      },
    },
  } as const;

  private readonly orderSessionListSelect = {
    id: true,
    sessionStatus: true,
    guestCount: true,
    createdAt: true,
    updatedAt: true,
    table: {
      select: {
        id: true,
        name: true,
        status: true,
      },
    },
    employee: {
      select: {
        id: true,
        fullName: true,
      },
    },
    _count: {
      select: {
        orderItems: true,
      },
    },
  } as const;

  private createEventBase(
    affectedTableIds: Array<string | null | undefined>,
  ): OrderEventBase {
    return {
      eventId: randomUUID(),
      occurredAt: new Date().toISOString(),
      affectedTableIds: [
        ...new Set(
          affectedTableIds.filter((tableId): tableId is string =>
            Boolean(tableId),
          ),
        ),
      ],
    };
  }

  private success(message: string) {
    return {
      success: true,
      message,
    };
  }

  private runSerializableTransaction<T>(
    callback: (tx: ExtendedPrismaTransactionClient) => Promise<T>,
  ): Promise<T> {
    return executeSerializableTransaction(this.prisma, callback, {
      loggerContext: 'Orders transaction',
    });
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

  async openSession({ tableId, employeeId, guestCount }: OpenSessionInput) {
    return this.runSerializableTransaction((tx) =>
      this.createOrderSession(tx, {
        tableId,
        employeeId,
        guestCount,
      }),
    );
  }

  async checkInReservation(reservationId: number, employeeId: string) {
    const result = await this.runSerializableTransaction(async (tx) => {
      const now = new Date();
      const reservation = await tx.reservation.findUnique({
        where: { id: reservationId },
      });
      if (!reservation) {
        throw new NotFoundException(
          `Reservation with ID ${reservationId} not found.`,
        );
      }
      if (
        reservation.status !== ReservationStatus.PENDING ||
        reservation.orderSessionId !== null
      ) {
        throw new ConflictException('Reservation is no longer pending.');
      }

      const checkInOpensAt = new Date(
        reservation.startsAt.getTime() - RESERVATION_CHECK_IN_EARLY_MS,
      );
      const checkInClosesAt = new Date(
        reservation.startsAt.getTime() + RESERVATION_NO_SHOW_GRACE_MS,
      );
      if (now < checkInOpensAt) {
        throw new BadRequestException(
          'Check-in opens 30 minutes before the reservation.',
        );
      }
      if (now >= checkInClosesAt) {
        throw new ConflictException('The reservation check-in window closed.');
      }

      const session = await this.createOrderSession(tx, {
        tableId: reservation.tableId,
        employeeId,
        guestCount: reservation.guestCount,
      });
      const checkedIn = await tx.reservation.updateMany({
        where: {
          id: reservationId,
          status: ReservationStatus.PENDING,
          orderSessionId: null,
        },
        data: {
          status: ReservationStatus.ARRIVED,
          checkedInAt: now,
          orderSessionId: session.id,
        },
      });
      if (checkedIn.count !== 1) {
        throw new ConflictException('Reservation status has changed.');
      }

      await tx.actionLog.create({
        data: {
          employeeId,
          actionType: 'RESERVATION_CHECKED_IN',
          details: {
            reservationId,
            orderSessionId: session.id,
            tableId: reservation.tableId,
          },
        },
      });

      return {
        reservation: {
          id: reservation.id,
          status: ReservationStatus.ARRIVED,
          checkedInAt: now,
          orderSessionId: session.id,
        },
        orderSession: session,
      };
    });

    return result;
  }

  private async createOrderSession(
    tx: ExtendedPrismaTransactionClient,
    { tableId, employeeId, guestCount }: OpenSessionInput,
  ) {
    await this.assertActiveEmployee(tx, employeeId);
    const shiftId = await this.cashierShiftLedger.findOpenShiftId(
      tx,
      employeeId,
    );

    const table = tableId
      ? await tx.diningTable.findFirst({
          where: { id: tableId, deletedAt: null },
          select: { id: true, name: true, status: true },
        })
      : null;

    if (tableId) {
      if (!table) {
        throw new NotFoundException(
          `Dining table with ID ${tableId} not found.`,
        );
      }

      const claimedTable = await tx.diningTable.updateMany({
        where: { id: tableId, deletedAt: null, status: TableStatus.EMPTY },
        data: { status: TableStatus.OCCUPIED },
      });
      if (claimedTable.count !== 1) {
        throw new BadRequestException(
          `Cannot open order session because table '${table.name}' is ${table.status}.`,
        );
      }
    }

    const session = await tx.orderSession.create({
      data: {
        tableId: tableId ?? null,
        employeeId,
        guestCount,
        shiftId,
      },
      include: this.orderSessionInclude,
    });
    await this.enqueueOrderEvent(
      tx,
      ORDER_EVENTS.SESSION_OPENED,
      'OrderSession',
      session.id,
      {
        ...this.createEventBase([session.tableId]),
        sessionId: session.id,
        tableId: session.tableId,
        employeeId: session.employeeId,
        shiftId: session.shiftId,
      },
    );
    return session;
  }

  async getActiveSessions() {
    return this.prisma.orderSession.findMany({
      where: {
        sessionStatus: SessionStatus.ACTIVE,
      },
      select: this.orderSessionListSelect,
      orderBy: {
        createdAt: 'desc',
      },
    });
  }

  async getHandoffItems(query: GetHandoffItemsDto) {
    const where: Prisma.OrderItemWhereInput = {
      serveStatus: ServeStatus.READY,
      orderSession: {
        is: {
          tableId: null,
          sessionStatus: { not: SessionStatus.CANCELLED },
        },
      },
    };
    const totalItems = await this.prisma.orderItem.count({ where });
    const paging = this.pagination.paging({ ...query, totalItems });
    const items = await this.prisma.orderItem.findMany({
      where,
      skip: paging.skip,
      take: paging.itemPerPage,
      orderBy: [{ readyAt: { sort: 'asc', nulls: 'last' } }, { id: 'asc' }],
      select: {
        id: true,
        quantity: true,
        readyAt: true,
        orderSessionId: true,
        menuItem: { select: { name: true } },
        kitchenTicketItem: {
          select: {
            ticket: {
              select: {
                sequence: true,
                station: { select: { code: true } },
              },
            },
          },
        },
      },
    });
    return paging.format(
      items.map(({ kitchenTicketItem, ...item }) => ({
        ...item,
        ticketNumber: kitchenTicketItem
          ? `${kitchenTicketItem.ticket.station.code}-${kitchenTicketItem.ticket.sequence}`
          : null,
      })),
    );
  }

  async getSessionById(id: string) {
    const session = await this.prisma.orderSession.findUnique({
      where: { id },
      include: this.orderSessionInclude,
    });

    if (!session) {
      throw new NotFoundException(`Order session with ID ${id} not found.`);
    }

    return session;
  }

  async addOrderItems(orderSessionId: string, { items }: AddOrderItemsDto) {
    const result = await this.runSerializableTransaction(async (tx) => {
      const session = await tx.orderSession.findUnique({
        where: { id: orderSessionId },
      });

      if (!session) {
        throw new NotFoundException(
          `Order session with ID ${orderSessionId} not found.`,
        );
      }

      this.orderPolicy.assertActiveSession(
        session.sessionStatus,
        'Cannot add items to an inactive order session.',
      );

      const menuItemIds = [...new Set(items.map((item) => item.menuItemId))];
      const menuItems = await tx.menuItem.findMany({
        where: {
          id: {
            in: menuItemIds,
          },
          deletedAt: null,
          isAvailable: true,
          OR: [
            { kitchenStationId: null },
            {
              kitchenStation: {
                is: { isActive: true, deletedAt: null },
              },
            },
          ],
        },
        select: {
          id: true,
          name: true,
          price: true,
          kitchenStation: {
            select: {
              id: true,
              code: true,
              name: true,
              prepSlaSeconds: true,
              printDevice: {
                select: { id: true, isActive: true, deletedAt: true },
              },
            },
          },
        },
      });

      if (menuItems.length !== menuItemIds.length) {
        throw new NotFoundException(
          'One or more menu items were not found or are unavailable.',
        );
      }

      const menuItemsById = new Map(
        menuItems.map((menuItem) => [menuItem.id, menuItem]),
      );

      const createdItems = await tx.orderItem.createManyAndReturn({
        data: items.map((item) => {
          const menuItem = menuItemsById.get(item.menuItemId);

          if (!menuItem) {
            throw new NotFoundException(
              `Menu item with ID ${item.menuItemId} not found.`,
            );
          }

          return {
            orderSessionId,
            menuItemId: item.menuItemId,
            quantity: item.quantity,
            priceAtTime: menuItem.price,
            note: item.note,
          };
        }),
        select: {
          id: true,
          menuItemId: true,
          quantity: true,
          note: true,
        },
      });

      const kitchenTickets = await this.kitchenRouting.createTickets(tx, {
        orderSessionId,
        menuItems,
        orderItems: createdItems,
      });

      const updatedSession = await tx.orderSession.findUnique({
        where: { id: orderSessionId },
        include: this.orderSessionInclude,
      });

      if (updatedSession) {
        await this.enqueueOrderEvent(
          tx,
          ORDER_EVENTS.ITEMS_ADDED,
          'OrderSession',
          updatedSession.id,
          {
            ...this.createEventBase([updatedSession.tableId]),
            sessionId: updatedSession.id,
            tableId: updatedSession.tableId,
            orderItemIds: createdItems.map((item) => item.id),
            kitchenTicketIds: kitchenTickets.map((ticket) => ticket.id),
          },
        );
      }

      return {
        session: updatedSession,
        orderItemIds: createdItems.map((item) => item.id),
      };
    });

    return result.session;
  }

  updateItemStatus(
    id: string,
    employeeId: string,
    { serveStatus }: UpdateOrderItemStatusDto,
  ) {
    return this.changeItemStatus(id, employeeId, serveStatus, false);
  }

  handoffTakeawayItem(id: string, employeeId: string) {
    return this.changeItemStatus(id, employeeId, ServeStatus.SERVED, true);
  }

  private async changeItemStatus(
    id: string,
    employeeId: string,
    serveStatus: ServeStatus,
    handoffOnly: boolean,
  ) {
    const result = await this.runSerializableTransaction(async (tx) => {
      await this.assertActiveEmployee(tx, employeeId);
      const item = await tx.orderItem.findUnique({
        where: { id },
        include: {
          orderSession: true,
          menuItem: true,
        },
      });

      if (!item) {
        throw new NotFoundException(`Order item with ID ${id} not found.`);
      }

      if (
        item.orderSession.sessionStatus === SessionStatus.CANCELLED ||
        (item.orderSession.sessionStatus === SessionStatus.COMPLETED &&
          !item.invoiceId)
      ) {
        throw new BadRequestException(
          'Cannot update item status in this order session.',
        );
      }
      if (item.serveStatus === ServeStatus.CANCELLED) {
        throw new BadRequestException('Cannot change a cancelled order item.');
      }
      if (
        handoffOnly &&
        (item.orderSession.tableId !== null ||
          (item.serveStatus !== ServeStatus.READY &&
            item.serveStatus !== ServeStatus.SERVED))
      ) {
        throw new ConflictException('Takeaway item is not ready for handoff.');
      }
      if (
        serveStatus === ServeStatus.READY &&
        item.orderSession.tableId !== null
      ) {
        throw new BadRequestException(
          'READY handoff is only supported for takeaway orders.',
        );
      }

      if (item.serveStatus === serveStatus) {
        return {
          item,
          updatedItem: item,
          inventoryMovements: [],
          changed: false,
        };
      }

      this.orderPolicy.assertServeStatusTransition(
        item.serveStatus,
        serveStatus,
      );

      const updateResult = await tx.orderItem.updateMany({
        where: {
          id,
          serveStatus: item.serveStatus,
          orderSession: {
            is: {
              sessionStatus: item.orderSession.sessionStatus,
            },
          },
        },
        data: {
          serveStatus,
          ...(serveStatus === ServeStatus.READY ? { readyAt: new Date() } : {}),
        },
      });

      if (updateResult.count !== 1) {
        throw new ConflictException(
          'Order item was changed by another operation. Please refresh and try again.',
        );
      }

      const inventoryMovements =
        serveStatus === ServeStatus.COOKING
          ? await this.inventoryConsumption.consumeOrderItem(tx, item)
          : [];

      await tx.actionLog.create({
        data: {
          employeeId,
          actionType: 'ORDER_ITEM_STATUS_UPDATED',
          details: {
            orderItemId: id,
            previousStatus: item.serveStatus,
            currentStatus: serveStatus,
            inventoryMovements: inventoryMovements.map((movement) => ({
              inventoryItemId: movement.inventoryItemId,
              transactionId: movement.transactionId,
              quantity: movement.quantity.toString(),
              stockAfter: movement.stockAfter.toString(),
            })),
          },
        },
      });

      const updatedItem = await tx.orderItem.findUnique({
        where: { id },
        include: {
          menuItem: true,
        },
      });

      if (!updatedItem) {
        throw new NotFoundException(`Order item with ID ${id} not found.`);
      }

      await this.enqueueOrderEvent(
        tx,
        ORDER_EVENTS.ITEM_STATUS_UPDATED,
        'OrderItem',
        updatedItem.id,
        {
          ...this.createEventBase([item.orderSession.tableId]),
          orderItemId: updatedItem.id,
          orderSessionId: item.orderSessionId,
          tableId: item.orderSession.tableId,
          previousStatus: item.serveStatus,
          currentStatus: updatedItem.serveStatus,
          isServed: updatedItem.serveStatus === ServeStatus.SERVED,
        },
      );

      return { item, updatedItem, inventoryMovements, changed: true };
    });

    return result.updatedItem;
  }

  async cancelItem(
    id: string,
    employeeId: string,
    { reason }: CancelOrderItemDto,
  ) {
    const result = await this.runSerializableTransaction(async (tx) => {
      await this.assertActiveEmployee(tx, employeeId);
      const item = await tx.orderItem.findUnique({
        where: { id },
        include: {
          orderSession: true,
        },
      });

      if (!item) {
        throw new NotFoundException(`Order item with ID ${id} not found.`);
      }

      this.orderPolicy.assertNoPaidOrInvoicedItems(
        [item],
        'Cannot cancel a paid or invoiced order item.',
      );
      this.orderPolicy.assertActiveSession(
        item.orderSession.sessionStatus,
        'Cannot cancel item in an inactive order session.',
      );

      if (item.serveStatus === ServeStatus.CANCELLED) {
        throw new BadRequestException('Order item is already cancelled.');
      }

      const wasPrepared =
        item.serveStatus === ServeStatus.COOKING ||
        item.serveStatus === ServeStatus.READY ||
        item.serveStatus === ServeStatus.SERVED;
      if (wasPrepared && !reason) {
        throw new BadRequestException(
          'A cancellation reason is required for a prepared order item.',
        );
      }

      const note = reason
        ? [item.note, `Cancel reason: ${reason}`].filter(Boolean).join('\n')
        : item.note;

      const updateResult = await tx.orderItem.updateMany({
        where: {
          id,
          isPaid: false,
          invoiceId: null,
          serveStatus: item.serveStatus,
          orderSession: {
            is: {
              sessionStatus: SessionStatus.ACTIVE,
            },
          },
        },
        data: {
          serveStatus: ServeStatus.CANCELLED,
          note,
        },
      });

      if (updateResult.count !== 1) {
        throw new ConflictException(
          'Order item was changed by another operation. Please refresh and try again.',
        );
      }

      const wasteRecords =
        wasPrepared && reason
          ? await this.inventoryConsumption.recordWaste(tx, {
              orderItemId: id,
              employeeId,
              reason,
            })
          : [];

      await tx.actionLog.create({
        data: {
          employeeId,
          actionType: 'ORDER_ITEM_CANCELLED',
          details: {
            orderItemId: id,
            previousStatus: item.serveStatus,
            reason: reason ?? null,
            waste: wasteRecords.map((waste) => ({
              inventoryItemId: waste.inventoryItemId,
              wasteId: waste.id,
              quantity: waste.quantity.toString(),
            })),
          },
        },
      });

      const updatedItem = await tx.orderItem.findUnique({
        where: { id },
        include: {
          menuItem: true,
        },
      });

      if (!updatedItem) {
        throw new NotFoundException(`Order item with ID ${id} not found.`);
      }

      await this.enqueueOrderEvent(
        tx,
        ORDER_EVENTS.ITEM_STATUS_UPDATED,
        'OrderItem',
        updatedItem.id,
        {
          ...this.createEventBase([item.orderSession.tableId]),
          orderItemId: updatedItem.id,
          orderSessionId: item.orderSessionId,
          tableId: item.orderSession.tableId,
          previousStatus: item.serveStatus,
          currentStatus: updatedItem.serveStatus,
          isServed: false,
        },
      );

      return { item, updatedItem };
    });

    return result.updatedItem;
  }

  async cancelSession(id: string) {
    const updatedSession = await this.runSerializableTransaction(async (tx) => {
      const session = await tx.orderSession.findUnique({
        where: { id },
        include: {
          orderItems: true,
        },
      });

      if (!session) {
        throw new NotFoundException(`Order session with ID ${id} not found.`);
      }

      this.orderPolicy.assertActiveSession(
        session.sessionStatus,
        'Order session is already inactive.',
      );

      this.orderPolicy.assertNoPaidOrInvoicedItems(
        session.orderItems,
        'Cannot cancel an order session that contains paid or invoiced items.',
      );
      this.orderPolicy.assertNoProcessedItems(
        session.orderItems,
        'Cannot cancel session. Some items are already cooking or served. Please cancel them individually first.',
      );

      await tx.orderItem.updateMany({
        where: {
          orderSessionId: id,
          isPaid: false,
          invoiceId: null,
        },
        data: {
          serveStatus: ServeStatus.CANCELLED,
        },
      });

      const sessionUpdate = await tx.orderSession.updateMany({
        where: { id, sessionStatus: SessionStatus.ACTIVE },
        data: {
          sessionStatus: SessionStatus.CANCELLED,
        },
      });

      if (sessionUpdate.count !== 1) {
        throw new ConflictException(
          'Order session was changed by another operation. Please refresh and try again.',
        );
      }

      if (session.tableId) {
        await tx.diningTable.updateMany({
          where: { id: session.tableId },
          data: { status: TableStatus.EMPTY },
        });
      }

      const updatedSession = await tx.orderSession.findUnique({
        where: { id },
        include: this.orderSessionInclude,
      });

      if (!updatedSession) {
        throw new NotFoundException(`Order session with ID ${id} not found.`);
      }

      await this.enqueueOrderEvent(
        tx,
        ORDER_EVENTS.SESSION_CANCELLED,
        'OrderSession',
        updatedSession.id,
        {
          ...this.createEventBase([updatedSession.tableId]),
          sessionId: updatedSession.id,
          tableId: updatedSession.tableId,
        },
      );

      return updatedSession;
    });

    return updatedSession;
  }

  async transferTable({ fromTableId, toTableId }: TransferDiningTableDto) {
    const result = await this.runSerializableTransaction(async (tx) => {
      const fromTable = await tx.diningTable.findUnique({
        where: { id: fromTableId },
      });

      if (!fromTable) {
        throw new NotFoundException(
          `Dining table with ID ${fromTableId} not found.`,
        );
      }

      const toTable = await tx.diningTable.findUnique({
        where: { id: toTableId },
      });

      if (!toTable) {
        throw new NotFoundException(
          `Dining table with ID ${toTableId} not found.`,
        );
      }

      if (toTable.status !== TableStatus.EMPTY) {
        throw new BadRequestException(
          `Target table '${toTable.name}' is currently ${toTable.status}.`,
        );
      }

      const activeSession = await tx.orderSession.findFirst({
        where: {
          tableId: fromTableId,
          sessionStatus: SessionStatus.ACTIVE,
        },
      });

      if (!activeSession) {
        throw new NotFoundException(
          `No active order session found on table '${fromTable.name}'.`,
        );
      }

      const existingDestinationSession = await tx.orderSession.findFirst({
        where: {
          tableId: toTableId,
          sessionStatus: SessionStatus.ACTIVE,
        },
      });

      if (existingDestinationSession) {
        throw new ConflictException(
          `Dining table '${toTable.name}' already has an active order session.`,
        );
      }

      const claimedDestinationTable = await tx.diningTable.updateMany({
        where: {
          id: toTableId,
          status: TableStatus.EMPTY,
        },
        data: { status: TableStatus.OCCUPIED },
      });

      if (claimedDestinationTable.count !== 1) {
        throw new ConflictException(
          `Target table '${toTable.name}' was changed by another operation. Please refresh and try again.`,
        );
      }

      const sessionUpdate = await tx.orderSession.updateMany({
        where: {
          id: activeSession.id,
          tableId: fromTableId,
          sessionStatus: SessionStatus.ACTIVE,
        },
        data: { tableId: toTableId },
      });

      if (sessionUpdate.count !== 1) {
        throw new ConflictException(
          'Order session was moved or closed by another operation. Please refresh and try again.',
        );
      }

      await tx.diningTable.updateMany({
        where: { id: fromTableId, status: TableStatus.OCCUPIED },
        data: { status: TableStatus.EMPTY },
      });

      await this.enqueueOrderEvent(
        tx,
        ORDER_EVENTS.SESSION_TABLE_TRANSFERRED,
        'OrderSession',
        activeSession.id,
        {
          ...this.createEventBase([fromTableId, toTableId]),
          sessionId: activeSession.id,
          fromTableId,
          toTableId,
        },
      );

      return {
        response: this.success('Table transferred successfully.'),
        sessionId: activeSession.id,
      };
    });

    this.logger.log(
      `Session ${result.sessionId} transferred from ${fromTableId} to ${toTableId}`,
    );

    return result.response;
  }

  async mergeTables({
    sourceTableIds,
    destinationTableId,
  }: MergeDiningTableDto) {
    const uniqueSourceTableIds = [...new Set(sourceTableIds)];

    const result = await this.runSerializableTransaction(async (tx) => {
      const targetSession = await tx.orderSession.findFirst({
        where: {
          tableId: destinationTableId,
          sessionStatus: SessionStatus.ACTIVE,
        },
        include: {
          orderItems: {
            select: {
              isPaid: true,
              invoiceId: true,
            },
          },
        },
      });

      if (!targetSession) {
        throw new BadRequestException(
          'Destination table must have an active session to merge into.',
        );
      }

      const sourceSessions = await tx.orderSession.findMany({
        where: {
          tableId: { in: uniqueSourceTableIds },
          sessionStatus: SessionStatus.ACTIVE,
        },
        include: {
          orderItems: {
            select: {
              isPaid: true,
              invoiceId: true,
            },
          },
        },
      });

      if (sourceSessions.length !== uniqueSourceTableIds.length) {
        throw new BadRequestException(
          'Every source table must have an active session to merge.',
        );
      }

      const sourceSessionIds = sourceSessions.map((session) => session.id);
      const involvedItems = [
        ...targetSession.orderItems,
        ...sourceSessions.flatMap((session) => session.orderItems),
      ];

      this.orderPolicy.assertNoPaidOrInvoicedItems(
        involvedItems,
        'Cannot merge tables when any involved session contains paid or invoiced items.',
      );

      await tx.orderItem.updateMany({
        where: {
          orderSessionId: { in: sourceSessionIds },
          isPaid: false,
          invoiceId: null,
        },
        data: { orderSessionId: targetSession.id },
      });

      const sessionUpdate = await tx.orderSession.updateMany({
        where: {
          id: { in: sourceSessionIds },
          sessionStatus: SessionStatus.ACTIVE,
        },
        data: { sessionStatus: SessionStatus.COMPLETED },
      });

      if (sessionUpdate.count !== sourceSessionIds.length) {
        throw new ConflictException(
          'One or more source sessions were changed by another operation. Please refresh and try again.',
        );
      }

      await tx.diningTable.updateMany({
        where: { id: { in: uniqueSourceTableIds } },
        data: { status: TableStatus.EMPTY },
      });

      await this.enqueueOrderEvent(
        tx,
        ORDER_EVENTS.SESSIONS_MERGED,
        'OrderSession',
        targetSession.id,
        {
          ...this.createEventBase([
            ...uniqueSourceTableIds,
            destinationTableId,
          ]),
          targetSessionId: targetSession.id,
          destinationTableId,
          sourceSessionIds,
          sourceTableIds: uniqueSourceTableIds,
        },
      );

      return {
        response: this.success('Tables merged successfully.'),
        targetSessionId: targetSession.id,
        sourceSessionIds,
      };
    });

    this.logger.log(
      `Merged sessions [${result.sourceSessionIds.join(', ')}] into ${result.targetSessionId}`,
    );

    return result.response;
  }

  async splitTable({
    sourceOrderSessionId,
    destinationTableId,
    itemsToMove,
  }: SplitOrderSessionDto) {
    const orderItemIds = itemsToMove.map((item) => item.orderItemId);
    const uniqueOrderItemIds = [...new Set(orderItemIds)];

    if (uniqueOrderItemIds.length !== orderItemIds.length) {
      throw new BadRequestException('Duplicate order items are not allowed.');
    }

    const result = await this.runSerializableTransaction(async (tx) => {
      const destTable = await tx.diningTable.findUnique({
        where: { id: destinationTableId },
      });

      if (!destTable) {
        throw new NotFoundException(
          `Dining table with ID ${destinationTableId} not found.`,
        );
      }

      if (destTable.status !== TableStatus.EMPTY) {
        throw new BadRequestException('Destination table is not available.');
      }

      const sourceSession = await tx.orderSession.findUnique({
        where: { id: sourceOrderSessionId },
      });

      if (
        !sourceSession ||
        sourceSession.sessionStatus !== SessionStatus.ACTIVE
      ) {
        throw new BadRequestException(
          'Source session is not active or does not exist.',
        );
      }

      const existingDestinationSession = await tx.orderSession.findFirst({
        where: {
          tableId: destinationTableId,
          sessionStatus: SessionStatus.ACTIVE,
        },
      });

      if (existingDestinationSession) {
        throw new ConflictException(
          'Destination table already has an active order session.',
        );
      }

      const dbItems = (await tx.orderItem.findMany({
        where: {
          id: { in: uniqueOrderItemIds },
        },
      })) as SplittableOrderItem[];

      if (dbItems.length !== uniqueOrderItemIds.length) {
        throw new NotFoundException('One or more order items were not found.');
      }

      const dbItemsById = new Map(dbItems.map((item) => [item.id, item]));

      for (const payloadItem of itemsToMove) {
        const dbItem = dbItemsById.get(payloadItem.orderItemId);

        if (!dbItem) {
          throw new NotFoundException(
            `Item ${payloadItem.orderItemId} not found.`,
          );
        }

        if (dbItem.orderSessionId !== sourceOrderSessionId) {
          throw new BadRequestException(
            `Item ${payloadItem.orderItemId} does not belong to the source session.`,
          );
        }

        if (dbItem.isPaid || dbItem.invoiceId) {
          throw new BadRequestException(
            'Cannot split a paid or invoiced order item.',
          );
        }

        if (dbItem.serveStatus === ServeStatus.CANCELLED) {
          throw new BadRequestException('Cannot split a cancelled order item.');
        }

        if (dbItem.quantity !== payloadItem.expectedOriginalQuantity) {
          throw new ConflictException(
            `Data sync error for item ${dbItem.menuItemId}. Expected ${payloadItem.expectedOriginalQuantity} but found ${dbItem.quantity}. Please refresh the POS screen.`,
          );
        }

        if (payloadItem.quantityToMove > dbItem.quantity) {
          throw new BadRequestException(
            'Cannot move more items than originally ordered.',
          );
        }

        if (
          payloadItem.quantityToMove < dbItem.quantity &&
          dbItem.serveStatus !== ServeStatus.PENDING
        ) {
          throw new BadRequestException(
            'Processed order items can only be moved as a whole line.',
          );
        }
      }

      const claimedDestinationTable = await tx.diningTable.updateMany({
        where: {
          id: destinationTableId,
          status: TableStatus.EMPTY,
        },
        data: { status: TableStatus.OCCUPIED },
      });

      if (claimedDestinationTable.count !== 1) {
        throw new ConflictException(
          'Destination table was changed by another operation. Please refresh and try again.',
        );
      }

      const newDestSession = await tx.orderSession.create({
        data: {
          tableId: destinationTableId,
          sessionStatus: SessionStatus.ACTIVE,
          employeeId: sourceSession.employeeId,
          shiftId: sourceSession.shiftId,
        },
      });

      for (const payloadItem of itemsToMove) {
        const dbItem = dbItemsById.get(payloadItem.orderItemId);

        if (!dbItem) continue;

        if (payloadItem.quantityToMove === dbItem.quantity) {
          const moveResult = await tx.orderItem.updateMany({
            where: {
              id: dbItem.id,
              orderSessionId: sourceOrderSessionId,
              quantity: payloadItem.expectedOriginalQuantity,
              isPaid: false,
              invoiceId: null,
              serveStatus: dbItem.serveStatus,
            },
            data: { orderSessionId: newDestSession.id },
          });

          if (moveResult.count !== 1) {
            throw new ConflictException(
              `Item ${dbItem.id} was changed by another operation. Please refresh and try again.`,
            );
          }
        } else {
          const quantityUpdate = await tx.orderItem.updateMany({
            where: {
              id: dbItem.id,
              orderSessionId: sourceOrderSessionId,
              quantity: payloadItem.expectedOriginalQuantity,
              isPaid: false,
              invoiceId: null,
              serveStatus: dbItem.serveStatus,
            },
            data: { quantity: dbItem.quantity - payloadItem.quantityToMove },
          });

          if (quantityUpdate.count !== 1) {
            throw new ConflictException(
              `Item ${dbItem.id} was changed by another operation. Please refresh and try again.`,
            );
          }

          const movedItem = await tx.orderItem.create({
            data: {
              orderSessionId: newDestSession.id,
              menuItemId: dbItem.menuItemId,
              quantity: payloadItem.quantityToMove,
              priceAtTime: dbItem.priceAtTime,
              note: dbItem.note,
              serveStatus: dbItem.serveStatus,
            },
            select: { id: true },
          });

          const ticketItem = await tx.kitchenTicketItem.findUnique({
            where: { orderItemId: dbItem.id },
          });
          if (ticketItem) {
            await tx.kitchenTicketItem.update({
              where: { id: ticketItem.id },
              data: {
                quantity: dbItem.quantity - payloadItem.quantityToMove,
              },
            });
            await tx.kitchenTicketItem.create({
              data: {
                ticketId: ticketItem.ticketId,
                orderItemId: movedItem.id,
                itemName: ticketItem.itemName,
                quantity: payloadItem.quantityToMove,
                note: ticketItem.note,
              },
            });
          }
        }
      }

      await this.enqueueOrderEvent(
        tx,
        ORDER_EVENTS.SESSION_SPLIT,
        'OrderSession',
        sourceSession.id,
        {
          ...this.createEventBase([sourceSession.tableId, destinationTableId]),
          sourceSessionId: sourceSession.id,
          newSessionId: newDestSession.id,
          sourceTableId: sourceSession.tableId,
          destinationTableId,
        },
      );

      return {
        response: this.success('Table split successfully.'),
        sourceSessionId: sourceSession.id,
        sourceTableId: sourceSession.tableId,
        newSessionId: newDestSession.id,
      };
    });

    this.logger.log(
      `Split items from session ${result.sourceSessionId} to new session ${result.newSessionId}`,
    );

    return result.response;
  }

  async clearTable(tableId: string) {
    const result = await this.runSerializableTransaction(async (tx) => {
      const table = await tx.diningTable.findUnique({
        where: { id: tableId },
      });

      if (!table) {
        throw new NotFoundException(
          `Dining table with ID ${tableId} not found.`,
        );
      }

      const activeSession = await tx.orderSession.findFirst({
        where: { tableId, sessionStatus: SessionStatus.ACTIVE },
        include: { orderItems: true },
      });

      if (activeSession) {
        this.orderPolicy.assertNoPaidOrInvoicedItems(
          activeSession.orderItems,
          'Cannot clear table because it contains paid or invoiced items.',
        );
        this.orderPolicy.assertNoProcessedItems(
          activeSession.orderItems,
          'Cannot clear table. Some items are already cooking or served. Please cancel them individually first.',
        );

        await tx.orderItem.updateMany({
          where: {
            orderSessionId: activeSession.id,
            isPaid: false,
            invoiceId: null,
          },
          data: { serveStatus: ServeStatus.CANCELLED },
        });

        const sessionUpdate = await tx.orderSession.updateMany({
          where: {
            id: activeSession.id,
            sessionStatus: SessionStatus.ACTIVE,
          },
          data: { sessionStatus: SessionStatus.CANCELLED },
        });

        if (sessionUpdate.count !== 1) {
          throw new ConflictException(
            'Order session was changed by another operation. Please refresh and try again.',
          );
        }
      }

      await tx.diningTable.updateMany({
        where: { id: tableId },
        data: { status: TableStatus.EMPTY },
      });

      await this.enqueueOrderEvent(
        tx,
        ORDER_EVENTS.TABLE_CLEARED,
        'DiningTable',
        tableId,
        {
          ...this.createEventBase([tableId]),
          tableId,
          cancelledSessionId: activeSession?.id ?? null,
        },
      );

      return {
        response: this.success('Table cleared and session cancelled.'),
        cancelledSessionId: activeSession?.id ?? null,
      };
    });

    return result.response;
  }

  private enqueueOrderEvent(
    tx: ExtendedPrismaTransactionClient,
    eventName: string,
    aggregateType: string,
    aggregateId: string,
    payload: unknown,
  ) {
    return this.outbox.enqueue(tx, {
      topic: 'order',
      eventName,
      aggregateType,
      aggregateId,
      payload,
    });
  }
}
