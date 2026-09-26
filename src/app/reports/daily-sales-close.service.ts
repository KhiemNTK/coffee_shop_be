import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { Prisma, type DailySalesClose } from '@prisma/client';
import {
  PRISMA_SERVICE_TOKEN,
  type ExtendedPrismaClient,
} from '../../common/prisma/prisma.service';
import { runSerializableTransaction } from '../../common/prisma/transaction.util';
import type {
  ReportDailyCloseBlockersRow,
  ReportRefundTotalsRow,
} from '../../common/types';
import { queryProfitability } from './profitability.query';

const DAY_MS = 24 * 60 * 60 * 1000;
const VIETNAM_UTC_OFFSET_MS = 7 * 60 * 60 * 1000;
const BUSINESS_TIME_ZONE = 'Asia/Ho_Chi_Minh';

@Injectable()
export class DailySalesCloseService {
  constructor(
    @Inject(PRISMA_SERVICE_TOKEN)
    private readonly prisma: ExtendedPrismaClient,
  ) {}

  async close(businessDate: string, employeeId: string) {
    const period = this.periodFor(businessDate);
    if (period.to > new Date()) {
      throw new BadRequestException('The business day has not ended.');
    }

    const close = await runSerializableTransaction(
      this.prisma,
      async (tx) => {
        const employee = await tx.employee.findFirst({
          where: { id: employeeId, isActive: true, deletedAt: null },
          select: { id: true },
        });
        if (!employee) {
          throw new UnauthorizedException('Employee is inactive or not found.');
        }

        const existing = await tx.dailySalesClose.findUnique({
          where: { businessDate: period.date },
        });
        if (existing) return existing;

        const [blockers] = await tx.$queryRaw<ReportDailyCloseBlockersRow[]>(
          Prisma.sql`
            SELECT
              (SELECT COUNT(*) FROM "CashierShift" cs
               WHERE cs."status" = 'OPEN' AND cs."openedAt" < ${period.to}
              )::bigint AS "openShiftCount",
              (SELECT COUNT(*) FROM "Invoice" i
               WHERE i."createdAt" >= ${period.from}
                 AND i."createdAt" < ${period.to}
                 AND i."paymentStatus" = 'UNPAID'
              )::bigint AS "unpaidInvoiceCount",
              (SELECT COUNT(*) FROM "OrderItem" oi
               JOIN "Invoice" i ON i."id" = oi."invoiceId"
               WHERE i."createdAt" >= ${period.from}
                 AND i."createdAt" < ${period.to}
                 AND i."paymentStatus" IN ('PAID', 'PARTIALLY_REFUNDED', 'REFUNDED')
                 AND oi."serveStatus" IN ('PENDING', 'COOKING', 'READY')
              )::bigint AS "unfinishedItemCount",
              (SELECT COUNT(*) FROM "PaymentAttempt" pa
               JOIN "Invoice" i ON i."id" = pa."invoiceId"
               WHERE i."createdAt" >= ${period.from}
                 AND i."createdAt" < ${period.to}
                 AND pa."status" IN ('PENDING', 'REQUIRES_REVIEW')
              )::bigint AS "uncertainPaymentCount",
              (SELECT COUNT(*) FROM "PaymentRefund" pr
               JOIN "PaymentAttempt" pa ON pa."id" = pr."paymentAttemptId"
               JOIN "Invoice" i ON i."id" = pa."invoiceId"
               WHERE i."createdAt" >= ${period.from}
                 AND i."createdAt" < ${period.to}
                 AND pr."status" IN ('PENDING', 'PROCESSING', 'REQUIRES_REVIEW')
              )::bigint AS "uncertainRefundCount",
              (SELECT COUNT(*) FROM "PaymentReconciliationIncident" pri
               WHERE pri."status" = 'OPEN'
                 AND (
                   EXISTS (
                     SELECT 1 FROM "PaymentAttempt" pa
                     JOIN "Invoice" i ON i."id" = pa."invoiceId"
                     WHERE pa."id" = pri."paymentAttemptId"
                       AND i."createdAt" >= ${period.from}
                       AND i."createdAt" < ${period.to}
                   )
                   OR EXISTS (
                     SELECT 1 FROM "PaymentRefund" pr
                     JOIN "PaymentAttempt" pa ON pa."id" = pr."paymentAttemptId"
                     JOIN "Invoice" i ON i."id" = pa."invoiceId"
                     WHERE pr."id" = pri."paymentRefundId"
                       AND i."createdAt" >= ${period.from}
                       AND i."createdAt" < ${period.to}
                   )
                 )
              )::bigint AS "openIncidentCount"
          `,
        );
        const pending = {
          openShifts: Number(blockers.openShiftCount),
          unpaidInvoices: Number(blockers.unpaidInvoiceCount),
          unfinishedItems: Number(blockers.unfinishedItemCount),
          uncertainPayments: Number(blockers.uncertainPaymentCount),
          uncertainRefunds: Number(blockers.uncertainRefundCount),
          openIncidents: Number(blockers.openIncidentCount),
        };
        if (Object.values(pending).some((count) => count > 0)) {
          throw new ConflictException({
            message: 'Resolve unfinished operations before closing the day.',
            blockers: pending,
          });
        }

        const closedAt = new Date();
        const snapshot = await queryProfitability(tx, period, closedAt);
        const created = await tx.dailySalesClose.create({
          data: {
            businessDate: period.date,
            timeZone: BUSINESS_TIME_ZONE,
            periodStart: period.from,
            periodEnd: period.to,
            closedAt,
            closedById: employeeId,
            snapshot,
          },
        });
        await tx.actionLog.create({
          data: {
            employeeId,
            actionType: 'DAILY_SALES_CLOSED',
            details: {
              dailySalesCloseId: created.id,
              businessDate,
              estimatedGrossProfit: snapshot.estimatedGrossProfit,
            },
          },
        });
        return created;
      },
      { loggerContext: 'DailySalesClose', retryUniqueViolations: true },
    );

    return this.withRefundDelta(close);
  }

  async get(businessDate: string) {
    const period = this.periodFor(businessDate);
    const close = await this.prisma.dailySalesClose.findUnique({
      where: { businessDate: period.date },
    });
    if (!close) {
      throw new NotFoundException(
        `Daily sales close for ${businessDate} not found.`,
      );
    }
    return this.withRefundDelta(close);
  }

  private async withRefundDelta(close: DailySalesClose) {
    const [currentRefunds] = await this.prisma.$queryRaw<
      ReportRefundTotalsRow[]
    >(
      Prisma.sql`
        SELECT COUNT(*)::bigint AS count,
          COALESCE(SUM(pr."amount"), 0)::numeric AS amount
        FROM "PaymentRefund" pr
        JOIN "PaymentAttempt" pa ON pa."id" = pr."paymentAttemptId"
        JOIN "Invoice" i ON i."id" = pa."invoiceId"
        WHERE i."createdAt" >= ${close.periodStart}
          AND i."createdAt" < ${close.periodEnd}
          AND pr."status" = 'SUCCEEDED'
      `,
    );
    const snapshot = close.snapshot as {
      refundCount: number;
      refundAmount: string;
    };
    return {
      ...close,
      businessDate: close.businessDate.toISOString().slice(0, 10),
      refundDeltaSinceClose: {
        count: Number(currentRefunds?.count ?? 0) - snapshot.refundCount,
        amount: (currentRefunds?.amount ?? new Prisma.Decimal(0))
          .minus(snapshot.refundAmount)
          .toFixed(2),
      },
    };
  }

  private periodFor(businessDate: string) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(businessDate)) {
      throw new BadRequestException('Invalid business date.');
    }
    const date = new Date(`${businessDate}T00:00:00.000Z`);
    if (
      Number.isNaN(date.getTime()) ||
      date.toISOString().slice(0, 10) !== businessDate
    ) {
      throw new BadRequestException('Invalid business date.');
    }
    // The single store uses Vietnam civil days; never use the server timezone.
    const from = new Date(date.getTime() - VIETNAM_UTC_OFFSET_MS);
    return {
      date,
      from,
      to: new Date(from.getTime() + DAY_MS),
    };
  }
}
