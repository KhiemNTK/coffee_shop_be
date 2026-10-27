import {
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import {
  CashExpenseRequestStatus,
  CashHandoverSettlementStatus,
  CashHandoverStatus,
  OutboxEventStatus,
  PaymentReconciliationIncidentStatus,
  PrintJobStatus,
  Prisma,
  ServeStatus,
} from '@prisma/client';
import {
  PRISMA_SERVICE_TOKEN,
  type ExtendedPrismaClient,
} from '../../common/prisma/prisma.service';
import { PaginationUtilService } from '../../common/utils/pagination-util/pagination-util.service';
import { GetManagementExceptionsDto } from './dto/get-management-exceptions.dto';
import { fulfillmentWhere } from '../online-orders/fulfillment-where';
import { readOutboxContext } from '../durable/outbox-context';
import { IdempotencyService } from '../durable/idempotency.service';
import { RetryOutboxEventDto } from './dto/retry-outbox-event.dto';

const handoverWhere: Prisma.CashHandoverWhereInput = {
  OR: [
    { status: CashHandoverStatus.PENDING },
    {
      status: CashHandoverStatus.APPROVED,
      settlementStatus: CashHandoverSettlementStatus.PENDING,
    },
  ],
};

const feedbackWhere: Prisma.TakeawayFeedbackWhereInput = {
  rating: { lte: 2 },
  resolvedAt: null,
};

function overdueKitchenWhere(asOf: Date): Prisma.KitchenTicketWhereInput {
  return {
    dueAt: { lt: asOf },
    OR: [{ availableAt: null }, { availableAt: { lte: asOf } }],
    station: { deletedAt: null },
    items: {
      some: {
        orderItem: {
          serveStatus: { in: [ServeStatus.PENDING, ServeStatus.COOKING] },
        },
      },
    },
  };
}

@Injectable()
export class ManagementExceptionsService {
  constructor(
    @Inject(PRISMA_SERVICE_TOKEN)
    private readonly prisma: ExtendedPrismaClient,
    private readonly pagination: PaginationUtilService,
    private readonly idempotency: IdempotencyService,
  ) {}

  async summary() {
    const asOf = new Date();
    const [
      payment,
      cashExpense,
      cashHandover,
      feedback,
      kitchen,
      pickup,
      outbox,
      print,
    ] = await Promise.all([
      this.prisma.paymentReconciliationIncident.count({
        where: { status: PaymentReconciliationIncidentStatus.OPEN },
      }),
      this.prisma.cashExpenseRequest.count({
        where: { status: CashExpenseRequestStatus.PENDING },
      }),
      this.prisma.cashHandover.count({ where: handoverWhere }),
      this.prisma.takeawayFeedback.count({ where: feedbackWhere }),
      this.prisma.kitchenTicket.count({ where: overdueKitchenWhere(asOf) }),
      this.prisma.onlineOrderRequest.count({ where: fulfillmentWhere(asOf) }),
      this.prisma.outboxEvent.count({
        where: { status: OutboxEventStatus.DEAD_LETTER },
      }),
      this.prisma.printJob.count({
        where: { status: PrintJobStatus.REQUIRES_REVIEW },
      }),
    ]);

    return {
      asOf: asOf.toISOString(),
      counts: {
        PAYMENT: payment,
        CASH_EXPENSE: cashExpense,
        CASH_HANDOVER: cashHandover,
        FEEDBACK: feedback,
        KITCHEN_OVERDUE: kitchen,
        ONLINE_PICKUP_LATE: pickup,
        OUTBOX_DEAD_LETTER: outbox,
        PRINT_REVIEW: print,
      },
      total:
        payment +
        cashExpense +
        cashHandover +
        feedback +
        kitchen +
        pickup +
        outbox +
        print,
    };
  }

  async findAll(query: GetManagementExceptionsDto) {
    const skip = (query.page - 1) * query.itemPerPage;
    const take = query.itemPerPage;

    switch (query.kind) {
      case 'OUTBOX_DEAD_LETTER': {
        const where = { status: OutboxEventStatus.DEAD_LETTER };
        const [totalItems, list] = await Promise.all([
          this.prisma.outboxEvent.count({ where }),
          this.prisma.outboxEvent.findMany({
            where,
            skip,
            take,
            orderBy: [{ occurredAt: 'asc' }, { id: 'asc' }],
            select: {
              id: true,
              topic: true,
              eventName: true,
              aggregateType: true,
              aggregateId: true,
              status: true,
              attempts: true,
              occurredAt: true,
              availableAt: true,
              lastErrorCode: true,
              lastFailedAt: true,
              context: true,
            },
          }),
        ]);
        return {
          kind: query.kind,
          ...this.pagination.paging({ ...query, totalItems }).format(
            list.map(({ context, ...event }) => ({
              ...event,
              requestId: readOutboxContext(context).requestId ?? null,
            })),
          ),
        };
      }
      case 'PRINT_REVIEW': {
        const where = { status: PrintJobStatus.REQUIRES_REVIEW };
        const [totalItems, list] = await Promise.all([
          this.prisma.printJob.count({ where }),
          this.prisma.printJob.findMany({
            where,
            skip,
            take,
            orderBy: [{ updatedAt: 'asc' }, { id: 'asc' }],
            select: {
              id: true,
              type: true,
              status: true,
              attempts: true,
              createdAt: true,
              updatedAt: true,
              invoiceId: true,
              kitchenTicketId: true,
              device: { select: { name: true } },
            },
          }),
        ]);
        return {
          kind: query.kind,
          ...this.pagination.paging({ ...query, totalItems }).format(list),
        };
      }
      case 'PAYMENT': {
        const where = {
          status: PaymentReconciliationIncidentStatus.OPEN,
        };
        const [totalItems, list] = await Promise.all([
          this.prisma.paymentReconciliationIncident.count({ where }),
          this.prisma.paymentReconciliationIncident.findMany({
            where,
            skip,
            take,
            orderBy: [{ detectedAt: 'asc' }, { id: 'asc' }],
            select: {
              id: true,
              type: true,
              title: true,
              detectedAt: true,
              paymentAttemptId: true,
              paymentRefundId: true,
            },
          }),
        ]);
        return {
          kind: query.kind,
          ...this.pagination.paging({ ...query, totalItems }).format(list),
        };
      }
      case 'CASH_EXPENSE': {
        const where = { status: CashExpenseRequestStatus.PENDING };
        const [totalItems, list] = await Promise.all([
          this.prisma.cashExpenseRequest.count({ where }),
          this.prisma.cashExpenseRequest.findMany({
            where,
            skip,
            take,
            orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
            select: {
              id: true,
              amount: true,
              description: true,
              createdAt: true,
              requestedById: true,
              shiftId: true,
            },
          }),
        ]);
        return {
          kind: query.kind,
          ...this.pagination.paging({ ...query, totalItems }).format(list),
        };
      }
      case 'CASH_HANDOVER': {
        const [totalItems, list] = await Promise.all([
          this.prisma.cashHandover.count({ where: handoverWhere }),
          this.prisma.cashHandover.findMany({
            where: handoverWhere,
            skip,
            take,
            orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
            select: {
              id: true,
              status: true,
              settlementStatus: true,
              varianceAmount: true,
              transferAmount: true,
              settlementDueAt: true,
              createdAt: true,
              shiftId: true,
            },
          }),
        ]);
        return {
          kind: query.kind,
          ...this.pagination.paging({ ...query, totalItems }).format(list),
        };
      }
      case 'FEEDBACK': {
        const [totalItems, list] = await Promise.all([
          this.prisma.takeawayFeedback.count({ where: feedbackWhere }),
          this.prisma.takeawayFeedback.findMany({
            where: feedbackWhere,
            skip,
            take,
            orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
            select: {
              id: true,
              rating: true,
              comment: true,
              createdAt: true,
              invoiceId: true,
            },
          }),
        ]);
        return {
          kind: query.kind,
          ...this.pagination.paging({ ...query, totalItems }).format(list),
        };
      }
      case 'KITCHEN_OVERDUE': {
        const where = overdueKitchenWhere(new Date());
        const [totalItems, list] = await Promise.all([
          this.prisma.kitchenTicket.count({ where }),
          this.prisma.kitchenTicket.findMany({
            where,
            skip,
            take,
            orderBy: [{ dueAt: 'asc' }, { id: 'asc' }],
            select: {
              id: true,
              sequence: true,
              dueAt: true,
              createdAt: true,
              stationId: true,
              station: { select: { code: true, name: true } },
              orderSessionId: true,
            },
          }),
        ]);
        return {
          kind: query.kind,
          ...this.pagination.paging({ ...query, totalItems }).format(list),
        };
      }
      case 'ONLINE_PICKUP_LATE': {
        const where = fulfillmentWhere(new Date());
        const [totalItems, list] = await Promise.all([
          this.prisma.onlineOrderRequest.count({ where }),
          this.prisma.onlineOrderRequest.findMany({
            where,
            skip,
            take,
            orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
            select: {
              id: true,
              pickupAt: true,
              createdAt: true,
              orderSessionId: true,
            },
          }),
        ]);
        return {
          kind: query.kind,
          ...this.pagination.paging({ ...query, totalItems }).format(list),
        };
      }
    }
  }

  retryOutboxEvent(id: string, employeeId: string, dto: RetryOutboxEventDto) {
    return this.idempotency.execute(
      {
        employeeId,
        operation: 'management.outbox.retry',
        key: dto.idempotencyKey,
        request: {
          id,
          reason: dto.reason,
          expectedAvailableAt: dto.expectedAvailableAt,
        },
      },
      async (tx) => {
        const employee = await tx.employee.findFirst({
          where: { id: employeeId, isActive: true, deletedAt: null },
          select: { id: true },
        });
        if (!employee) throw new UnauthorizedException('Employee is inactive.');
        const event = await tx.outboxEvent.findUnique({
          where: { id },
          select: { status: true, attempts: true, availableAt: true },
        });
        if (!event) throw new NotFoundException('Outbox event not found.');
        const updated = await tx.outboxEvent.updateMany({
          where: {
            id,
            status: OutboxEventStatus.DEAD_LETTER,
            availableAt: new Date(dto.expectedAvailableAt),
          },
          data: {
            status: OutboxEventStatus.PENDING,
            attempts: 0,
            availableAt: new Date(),
            lockedAt: null,
            lockedBy: null,
          },
        });
        if (updated.count !== 1) {
          throw new ConflictException(
            'Outbox event changed. Reload before retrying.',
          );
        }
        await tx.actionLog.create({
          data: {
            employeeId,
            actionType: 'OUTBOX_EVENT_RETRY',
            details: {
              outboxEventId: id,
              reason: dto.reason,
              previousStatus: event.status,
              previousAttempts: event.attempts,
              previousAvailableAt: event.availableAt.toISOString(),
              status: OutboxEventStatus.PENDING,
            },
          },
        });
        return { id, status: OutboxEventStatus.PENDING };
      },
    );
  }
}
