import { randomUUID } from 'node:crypto';
import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import {
  Prisma,
  ServeStatus,
  SessionStatus,
  TableStatus,
} from '@prisma/client';
import {
  AddOrderItemsDto,
  CancelOrderItemDto,
  MergeDiningTableDto,
  SplitOrderSessionDto,
  TransferDiningTableDto,
  UpdateOrderItemStatusDto,
} from './dto';
import { PRISMA_SERVICE_TOKEN } from '../../common/prisma/prisma.service';
import type { ExtendedPrismaClient } from '../../common/prisma/prisma.service';
import { ORDER_EVENTS } from './events/order.events';
import { OrderEventsPublisher } from './events/order-events.publisher';
import { OrderPolicyService } from './order-policy.service';
import type {
  ExtendedPrismaTransactionClient,
  MenuItemPriceSnapshot,
  OpenSessionInput,
  OrderEventBase,
  SplittableOrderItem,
} from '../../common/types';

@Injectable()
export class OrdersService {
  private readonly logger = new Logger(OrdersService.name);
  private readonly maxSerializableTransactionRetries = 3;
  private readonly serializableTransaction = {
    isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
  } as const;

  constructor(
    @Inject(PRISMA_SERVICE_TOKEN)
    private readonly prisma: ExtendedPrismaClient,
    private readonly orderEventsPublisher: OrderEventsPublisher,
    private readonly orderPolicy: OrderPolicyService,
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

  private async runSerializableTransaction<T>(
    callback: (tx: ExtendedPrismaTransactionClient) => Promise<T>,
  ): Promise<T> {
    for (
      let attempt = 1;
      attempt <= this.maxSerializableTransactionRetries;
      attempt++
    ) {
      try {
        return await this.prisma.$transaction(
          callback,
          this.serializableTransaction,
        );
      } catch (error) {
        if (
          this.isSerializableTransactionConflict(error) &&
          attempt < this.maxSerializableTransactionRetries
        ) {
          this.logger.warn(
            `Serializable transaction conflict. Retrying attempt ${attempt + 1}/${this.maxSerializableTransactionRetries}`,
          );
          await new Promise((resolve) => setTimeout(resolve, attempt * 25));
          continue;
        }

        throw error;
      }
    }

    throw new ConflictException('Transaction failed. Please try again.');
  }

  private isSerializableTransactionConflict(error: unknown) {
    return (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === 'P2034'
    );
  }

  async openSession({
    tableId,
    employeeId,
    guestCount,
    shiftId,
  }: OpenSessionInput) {
    const session = await this.runSerializableTransaction(async (tx) => {
      const employee = await tx.employee.findUnique({
        where: { id: employeeId },
      });

      if (!employee) {
        throw new NotFoundException(
          `Employee with ID ${employeeId} not found.`,
        );
      }

      if (shiftId) {
        const shift = await tx.cashierShift.findUnique({
          where: { id: shiftId },
        });

        if (!shift) {
          throw new NotFoundException(
            `Cashier shift with ID ${shiftId} not found.`,
          );
        }
      }

      const table = tableId
        ? await tx.diningTable.findUnique({
            where: { id: tableId },
          })
        : null;

      if (tableId) {
        if (!table) {
          throw new NotFoundException(
            `Dining table with ID ${tableId} not found.`,
          );
        }

        const claimedTable = await tx.diningTable.updateMany({
          where: {
            id: tableId,
            status: TableStatus.EMPTY,
          },
          data: { status: TableStatus.OCCUPIED },
        });

        if (claimedTable.count !== 1) {
          throw new BadRequestException(
            `Cannot open order session because table '${table.name}' is ${table.status}.`,
          );
        }

        const activeSession = await tx.orderSession.findFirst({
          where: {
            tableId,
            sessionStatus: SessionStatus.ACTIVE,
          },
        });

        if (activeSession) {
          throw new ConflictException(
            `Dining table '${table.name}' already has an active order session.`,
          );
        }
      }

      const session = await tx.orderSession.create({
        data: {
          tableId: tableId ?? null,
          employeeId,
          guestCount,
          shiftId: shiftId ?? null,
        },
        include: this.orderSessionInclude,
      });

      return session;
    });

    this.orderEventsPublisher.emit(ORDER_EVENTS.SESSION_OPENED, {
      ...this.createEventBase([session.tableId]),
      sessionId: session.id,
      tableId: session.tableId,
      employeeId: session.employeeId,
      shiftId: session.shiftId,
    });

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
      const menuItems = (await tx.menuItem.findMany({
        where: {
          id: {
            in: menuItemIds,
          },
        },
        select: {
          id: true,
          price: true,
        },
      })) as MenuItemPriceSnapshot[];

      if (menuItems.length !== menuItemIds.length) {
        throw new NotFoundException('One or more menu items were not found.');
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
        select: { id: true },
      });

      const updatedSession = await tx.orderSession.findUnique({
        where: { id: orderSessionId },
        include: this.orderSessionInclude,
      });

      return {
        session: updatedSession,
        orderItemIds: createdItems.map((item) => item.id),
      };
    });

    if (result.session) {
      this.orderEventsPublisher.emit(ORDER_EVENTS.ITEMS_ADDED, {
        ...this.createEventBase([result.session.tableId]),
        sessionId: result.session.id,
        tableId: result.session.tableId,
        orderItemIds: result.orderItemIds,
      });
    }

    return result.session;
  }

  async updateItemStatus(
    id: string,
    { serveStatus }: UpdateOrderItemStatusDto,
  ) {
    if (serveStatus === ServeStatus.CANCELLED) {
      throw new BadRequestException(
        'Use the cancel item operation to cancel an order item.',
      );
    }

    const result = await this.runSerializableTransaction(async (tx) => {
      const item = await tx.orderItem.findUnique({
        where: { id },
        include: {
          orderSession: true,
        },
      });

      if (!item) {
        throw new NotFoundException(`Order item with ID ${id} not found.`);
      }

      this.orderPolicy.assertActiveSession(
        item.orderSession.sessionStatus,
        'Cannot update item status in an inactive order session.',
      );
      this.orderPolicy.assertItemCanBeChanged(item);

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
        data: { serveStatus },
      });

      if (updateResult.count !== 1) {
        throw new ConflictException(
          'Order item was changed by another operation. Please refresh and try again.',
        );
      }

      const updatedItem = await tx.orderItem.findUnique({
        where: { id },
        include: {
          menuItem: true,
        },
      });

      if (!updatedItem) {
        throw new NotFoundException(`Order item with ID ${id} not found.`);
      }

      return { item, updatedItem };
    });

    this.orderEventsPublisher.emit(ORDER_EVENTS.ITEM_STATUS_UPDATED, {
      ...this.createEventBase([result.item.orderSession.tableId]),
      orderItemId: result.updatedItem.id,
      orderSessionId: result.item.orderSessionId,
      tableId: result.item.orderSession.tableId,
      previousStatus: result.item.serveStatus,
      currentStatus: result.updatedItem.serveStatus,
      isServed: result.updatedItem.serveStatus === ServeStatus.SERVED,
    });

    return result.updatedItem;
  }

  async cancelItem(id: string, { reason }: CancelOrderItemDto) {
    const result = await this.runSerializableTransaction(async (tx) => {
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

      const updatedItem = await tx.orderItem.findUnique({
        where: { id },
        include: {
          menuItem: true,
        },
      });

      if (!updatedItem) {
        throw new NotFoundException(`Order item with ID ${id} not found.`);
      }

      return { item, updatedItem };
    });

    this.orderEventsPublisher.emit(ORDER_EVENTS.ITEM_STATUS_UPDATED, {
      ...this.createEventBase([result.item.orderSession.tableId]),
      orderItemId: result.updatedItem.id,
      orderSessionId: result.item.orderSessionId,
      tableId: result.item.orderSession.tableId,
      previousStatus: result.item.serveStatus,
      currentStatus: result.updatedItem.serveStatus,
      isServed: false,
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

      return updatedSession;
    });

    this.orderEventsPublisher.emit(ORDER_EVENTS.SESSION_CANCELLED, {
      ...this.createEventBase([updatedSession.tableId]),
      sessionId: updatedSession.id,
      tableId: updatedSession.tableId,
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

      return {
        response: this.success('Table transferred successfully.'),
        sessionId: activeSession.id,
      };
    });

    this.logger.log(
      `Session ${result.sessionId} transferred from ${fromTableId} to ${toTableId}`,
    );

    this.orderEventsPublisher.emit(ORDER_EVENTS.SESSION_TABLE_TRANSFERRED, {
      ...this.createEventBase([fromTableId, toTableId]),
      sessionId: result.sessionId,
      fromTableId,
      toTableId,
    });

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

      return {
        response: this.success('Tables merged successfully.'),
        targetSessionId: targetSession.id,
        sourceSessionIds,
      };
    });

    this.logger.log(
      `Merged sessions [${result.sourceSessionIds.join(', ')}] into ${result.targetSessionId}`,
    );

    this.orderEventsPublisher.emit(ORDER_EVENTS.SESSIONS_MERGED, {
      ...this.createEventBase([...uniqueSourceTableIds, destinationTableId]),
      targetSessionId: result.targetSessionId,
      destinationTableId,
      sourceSessionIds: result.sourceSessionIds,
      sourceTableIds: uniqueSourceTableIds,
    });

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

          await tx.orderItem.create({
            data: {
              orderSessionId: newDestSession.id,
              menuItemId: dbItem.menuItemId,
              quantity: payloadItem.quantityToMove,
              priceAtTime: dbItem.priceAtTime,
              note: dbItem.note,
              serveStatus: dbItem.serveStatus,
            },
          });
        }
      }

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

    this.orderEventsPublisher.emit(ORDER_EVENTS.SESSION_SPLIT, {
      ...this.createEventBase([result.sourceTableId, destinationTableId]),
      sourceSessionId: result.sourceSessionId,
      newSessionId: result.newSessionId,
      sourceTableId: result.sourceTableId,
      destinationTableId,
    });

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

      return {
        response: this.success('Table cleared and session cancelled.'),
        cancelledSessionId: activeSession?.id ?? null,
      };
    });

    this.orderEventsPublisher.emit(ORDER_EVENTS.TABLE_CLEARED, {
      ...this.createEventBase([tableId]),
      tableId,
      cancelledSessionId: result.cancelledSessionId,
    });

    return result.response;
  }
}
