import { Inject, Injectable } from '@nestjs/common';
import {
  CashExpenseRequestStatus,
  CashHandoverSettlementStatus,
  CashHandoverStatus,
  PaymentReconciliationIncidentStatus,
  Prisma,
} from '@prisma/client';
import {
  PRISMA_SERVICE_TOKEN,
  type ExtendedPrismaClient,
} from '../../common/prisma/prisma.service';
import { PaginationUtilService } from '../../common/utils/pagination-util/pagination-util.service';
import { GetManagementExceptionsDto } from './dto/get-management-exceptions.dto';

const handoverWhere: Prisma.CashHandoverWhereInput = {
  OR: [
    { status: CashHandoverStatus.PENDING },
    { settlementStatus: CashHandoverSettlementStatus.PENDING },
  ],
};

const feedbackWhere: Prisma.TakeawayFeedbackWhereInput = {
  rating: { lte: 2 },
  resolvedAt: null,
};

@Injectable()
export class ManagementExceptionsService {
  constructor(
    @Inject(PRISMA_SERVICE_TOKEN)
    private readonly prisma: ExtendedPrismaClient,
    private readonly pagination: PaginationUtilService,
  ) {}

  async summary() {
    const [payment, cashExpense, cashHandover, feedback] = await Promise.all([
      this.prisma.paymentReconciliationIncident.count({
        where: { status: PaymentReconciliationIncidentStatus.OPEN },
      }),
      this.prisma.cashExpenseRequest.count({
        where: { status: CashExpenseRequestStatus.PENDING },
      }),
      this.prisma.cashHandover.count({ where: handoverWhere }),
      this.prisma.takeawayFeedback.count({ where: feedbackWhere }),
    ]);

    return {
      counts: {
        PAYMENT: payment,
        CASH_EXPENSE: cashExpense,
        CASH_HANDOVER: cashHandover,
        FEEDBACK: feedback,
      },
      total: payment + cashExpense + cashHandover + feedback,
    };
  }

  async findAll(query: GetManagementExceptionsDto) {
    const skip = (query.page - 1) * query.itemPerPage;
    const take = query.itemPerPage;

    switch (query.kind) {
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
    }
  }
}
