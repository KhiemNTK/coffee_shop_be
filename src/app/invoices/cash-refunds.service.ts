import { createHash } from 'node:crypto';
import {
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import {
  CashFlowType,
  PaymentMethod,
  PaymentStatus,
  Prisma,
  ServeStatus,
} from '@prisma/client';
import {
  PRISMA_SERVICE_TOKEN,
  type ExtendedPrismaClient,
} from '../../common/prisma/prisma.service';
import { PaginationUtilService } from '../../common/utils/pagination-util/pagination-util.service';
import { CashierShiftLedgerService } from '../cashier-shifts/cashier-shift-ledger.service';
import { IdempotencyService } from '../durable/idempotency.service';
import { OutboxService } from '../durable/outbox.service';
import { CreateCashRefundDto, GetCashRefundsDto } from './dto';

const REFUND_INCLUDE = {
  requestedBy: { select: { id: true, fullName: true } },
  cashTransaction: { select: { id: true, shiftId: true, fundId: true } },
} as const satisfies Prisma.CashRefundInclude;

@Injectable()
export class CashRefundsService {
  constructor(
    @Inject(PRISMA_SERVICE_TOKEN) private readonly prisma: ExtendedPrismaClient,
    private readonly ledger: CashierShiftLedgerService,
    private readonly idempotency: IdempotencyService,
    private readonly outbox: OutboxService,
    private readonly pagination: PaginationUtilService,
  ) {}

  create(invoiceId: string, employeeId: string, dto: CreateCashRefundDto) {
    const request = {
      invoiceId,
      amount: new Prisma.Decimal(dto.amount).toFixed(2),
      reason: dto.reason,
    };
    const requestHash = createHash('sha256')
      .update(JSON.stringify(request))
      .digest('hex');
    return this.idempotency.execute(
      {
        employeeId,
        operation: 'invoice.cash-refund',
        key: dto.idempotencyKey,
        request: { ...request, expectedShiftId: dto.expectedShiftId },
      },
      async (tx) => {
        const employee = await tx.employee.findFirst({
          where: { id: employeeId, isActive: true, deletedAt: null },
          select: { id: true },
        });
        if (!employee)
          throw new UnauthorizedException('Employee is inactive or not found.');
        // The financial record retains replay protection after generic idempotency expires.
        const replay = await tx.cashRefund.findUnique({
          where: {
            requestedById_idempotencyKey: {
              requestedById: employeeId,
              idempotencyKey: dto.idempotencyKey,
            },
          },
          include: REFUND_INCLUDE,
        });
        if (replay) {
          if (
            replay.requestHash !== requestHash ||
            replay.cashTransaction.shiftId !== dto.expectedShiftId
          )
            throw new ConflictException(
              'Idempotency key was used for a different cash refund.',
            );
          return replay;
        }
        const invoice = await tx.invoice.findUnique({
          where: { id: invoiceId },
          include: {
            cashTransaction: true,
            orderItems: { select: { serveStatus: true } },
          },
        });
        if (!invoice) throw new NotFoundException('Invoice not found.');
        if (
          invoice.paymentMethod !== PaymentMethod.CASH ||
          (invoice.paymentStatus !== PaymentStatus.PAID &&
            invoice.paymentStatus !== PaymentStatus.PARTIALLY_REFUNDED)
        ) {
          throw new ConflictException(
            'Only a paid cash invoice can be refunded.',
          );
        }
        if (
          !invoice.cashTransaction ||
          invoice.cashTransaction.type !== CashFlowType.INCOME ||
          !invoice.cashTransaction.amount.equals(invoice.totalAmount)
        ) {
          throw new ConflictException(
            'Cash payment ledger must be reconciled before refunding.',
          );
        }
        if (
          invoice.orderItems.length === 0 ||
          invoice.orderItems.some(
            (item) => item.serveStatus !== ServeStatus.SERVED,
          )
        ) {
          throw new ConflictException(
            'All invoiced items must be handed off before a cash refund.',
          );
        }
        const totals = await tx.cashRefund.aggregate({
          where: { invoiceId },
          _sum: { amount: true },
        });
        const amount = new Prisma.Decimal(request.amount);
        const refundedAmount = (
          totals._sum.amount ?? new Prisma.Decimal(0)
        ).plus(amount);
        if (refundedAmount.gt(invoice.totalAmount))
          throw new ConflictException(
            'Refund exceeds the remaining paid amount.',
          );
        const shift = await this.ledger.requireOpenShift(tx, employeeId);
        if (shift.id !== dto.expectedShiftId) {
          throw new ConflictException({
            code: 'CASHIER_SHIFT_CHANGED',
            message:
              'The reviewed cashier shift changed. Review the refund again.',
          });
        }
        const debited = await tx.fund.updateMany({
          where: {
            id: shift.fundId,
            deletedAt: null,
            balance: { gte: amount },
          },
          data: { balance: { decrement: amount } },
        });
        if (debited.count !== 1)
          throw new ConflictException('Insufficient cash fund balance.');
        const movement = await tx.cashTransaction.create({
          data: {
            type: CashFlowType.EXPENSE,
            amount,
            description: `Cash refund for invoice ${invoice.invoiceNumber}`,
            transactionDate: new Date(),
            fundId: shift.fundId,
            shiftId: shift.id,
            employeeId,
          },
        });
        const refund = await tx.cashRefund.create({
          data: {
            invoiceId,
            amount,
            reason: dto.reason,
            requestedById: employeeId,
            idempotencyKey: dto.idempotencyKey,
            requestHash,
            cashTransactionId: movement.id,
          },
          include: REFUND_INCLUDE,
        });
        const paymentStatus = refundedAmount.equals(invoice.totalAmount)
          ? PaymentStatus.REFUNDED
          : PaymentStatus.PARTIALLY_REFUNDED;
        const updated = await tx.invoice.updateMany({
          where: { id: invoiceId, paymentStatus: invoice.paymentStatus },
          data: { paymentStatus },
        });
        if (updated.count !== 1)
          throw new ConflictException('Invoice payment state changed.');
        const details = {
          cashRefundId: refund.id,
          invoiceId,
          amount: request.amount,
          refundedAmount: refundedAmount.toFixed(2),
          paymentStatus,
          shiftId: shift.id,
          cashTransactionId: movement.id,
          reason: dto.reason,
        };
        await tx.actionLog.create({
          data: { employeeId, actionType: 'CASH_REFUND_SUCCEEDED', details },
        });
        await this.outbox.enqueue(tx, {
          topic: 'payment',
          eventName: 'CASH_REFUND_SUCCEEDED',
          aggregateType: 'CashRefund',
          aggregateId: refund.id,
          payload: details,
        });
        return refund;
      },
    );
  }

  async find(invoiceId: string, query: GetCashRefundsDto) {
    const invoice = await this.prisma.invoice.findUnique({
      where: { id: invoiceId },
      select: { id: true },
    });
    if (!invoice) throw new NotFoundException('Invoice not found.');
    const where = { invoiceId };
    const totalItems = await this.prisma.cashRefund.count({ where });
    const paging = this.pagination.paging({ ...query, totalItems });
    const refunds = await this.prisma.cashRefund.findMany({
      where,
      skip: paging.skip,
      take: paging.itemPerPage,
      orderBy: [{ completedAt: 'desc' }, { id: 'desc' }],
      include: REFUND_INCLUDE,
    });
    return paging.format(refunds);
  }
}
