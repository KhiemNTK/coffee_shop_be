import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import {
  CashExpenseRequestStatus,
  CashFlowType,
  CashHandoverStatus,
  FundType,
  PaymentMethod,
  PaymentAttemptStatus,
  PaymentRefundStatus,
  PaymentStatus,
  Prisma,
  SettingValueType,
  SessionStatus,
  ShiftStatus,
} from '@prisma/client';
import { CashControlSettingKeys } from '../../common/consts/cash-control-settings';
import {
  PRISMA_SERVICE_TOKEN,
  type ExtendedPrismaClient,
} from '../../common/prisma/prisma.service';
import type { ExtendedPrismaTransactionClient } from '../../common/types';
import { PaginationUtilService } from '../../common/utils/pagination-util/pagination-util.service';
import { IdempotencyService } from '../durable/idempotency.service';
import { CashierShiftLedgerService } from './cashier-shift-ledger.service';
import {
  ApproveCashExpenseRequestDto,
  CloseCashierShiftDto,
  CreateCashMovementDto,
  GetCashExpenseRequestsDto,
  GetCashierShiftsDto,
  OpenCashierShiftDto,
  RejectCashExpenseRequestDto,
} from './dto';

@Injectable()
export class CashierShiftsService {
  private readonly logger = new Logger(CashierShiftsService.name);

  constructor(
    @Inject(PRISMA_SERVICE_TOKEN)
    private readonly prisma: ExtendedPrismaClient,
    private readonly paginationUtil: PaginationUtilService,
    private readonly ledger: CashierShiftLedgerService,
    private readonly idempotency: IdempotencyService,
  ) {}

  async open(employeeId: string, dto: OpenCashierShiftDto) {
    const { idempotencyKey, ...request } = dto;
    try {
      return await this.executeMutation(
        employeeId,
        'cashier-shift.open',
        idempotencyKey,
        request,
        async (tx) => {
          await this.assertActiveEmployee(tx, employeeId);
          const fund = await tx.fund.findFirst({
            where: { id: dto.fundId, deletedAt: null },
            select: { id: true, type: true, balance: true },
          });
          if (!fund) {
            throw new NotFoundException(
              `Fund with ID ${dto.fundId} not found.`,
            );
          }
          if (fund.type !== FundType.CASH) {
            throw new ConflictException('Cashier shifts require a CASH fund.');
          }
          const pendingHandover = await tx.cashHandover.findFirst({
            where: {
              sourceFundId: fund.id,
              status: CashHandoverStatus.PENDING,
            },
            select: { id: true },
          });
          if (pendingHandover) {
            throw new ConflictException(
              'The fund has a pending cash handover and cannot open a new shift.',
            );
          }

          const startingCash = new Prisma.Decimal(dto.startingCash);
          const shift = await tx.cashierShift.create({
            data: {
              employeeId,
              fundId: fund.id,
              startingCash,
              expectedStartingCash: fund.balance,
              openingDifference: startingCash.minus(fund.balance),
            },
            include: this.shiftInclude,
          });
          await this.log(tx, employeeId, 'CASHIER_SHIFT_OPENED', {
            shiftId: shift.id,
            fundId: fund.id,
            startingCash: shift.startingCash.toString(),
            expectedStartingCash: shift.expectedStartingCash.toString(),
            openingDifference: shift.openingDifference.toString(),
          });
          return shift;
        },
      );
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        throw new ConflictException(
          'The employee or cash fund already has an open shift.',
        );
      }
      throw error;
    }
  }

  async getCurrent(employeeId: string) {
    return this.prisma.$transaction(async (tx) => {
      const shift = await tx.cashierShift.findFirst({
        where: { employeeId, status: ShiftStatus.OPEN },
        include: this.shiftInclude,
      });
      if (!shift) throw new NotFoundException('No open cashier shift found.');
      return this.withReconciliation(tx, shift);
    });
  }

  async findAll(query: GetCashierShiftsDto) {
    const where: Prisma.CashierShiftWhereInput = {
      ...(query.status ? { status: query.status } : {}),
      ...(query.employeeId ? { employeeId: query.employeeId } : {}),
      ...(query.fundId ? { fundId: query.fundId } : {}),
      ...(query.openedFrom || query.openedTo
        ? {
            openedAt: {
              ...(query.openedFrom ? { gte: query.openedFrom } : {}),
              ...(query.openedTo ? { lt: query.openedTo } : {}),
            },
          }
        : {}),
    };
    const totalItems = await this.prisma.cashierShift.count({ where });
    const paging = this.paginationUtil.paging({ ...query, totalItems });
    const shifts = await this.prisma.cashierShift.findMany({
      where,
      skip: paging.skip,
      take: paging.itemPerPage,
      orderBy: [{ openedAt: 'desc' }, { id: 'desc' }],
      include: this.shiftInclude,
    });
    return paging.format(
      shifts.map((shift) => ({
        ...shift,
        difference:
          shift.reportedEndingCash !== null && shift.actualEndingCash !== null
            ? shift.reportedEndingCash.minus(shift.actualEndingCash)
            : null,
      })),
    );
  }

  async findOne(id: string) {
    return this.prisma.$transaction(async (tx) => {
      const shift = await tx.cashierShift.findUnique({
        where: { id },
        include: this.shiftInclude,
      });
      if (!shift) {
        throw new NotFoundException(`Cashier shift with ID ${id} not found.`);
      }
      return this.withReconciliation(tx, shift);
    });
  }

  async findExpenseRequests(
    query: GetCashExpenseRequestsDto,
    requestedById?: string,
  ) {
    const where: Prisma.CashExpenseRequestWhereInput = {
      ...(query.status ? { status: query.status } : {}),
      ...(query.shiftId ? { shiftId: query.shiftId } : {}),
      ...(requestedById
        ? { requestedById }
        : query.requestedById
          ? { requestedById: query.requestedById }
          : {}),
    };
    const totalItems = await this.prisma.cashExpenseRequest.count({ where });
    const paging = this.paginationUtil.paging({ ...query, totalItems });
    const requests = await this.prisma.cashExpenseRequest.findMany({
      where,
      skip: paging.skip,
      take: paging.itemPerPage,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      include: this.expenseRequestInclude,
    });
    return paging.format(requests);
  }

  async addMovement(employeeId: string, dto: CreateCashMovementDto) {
    const { idempotencyKey, ...request } = dto;
    return this.executeMutation(
      employeeId,
      'cashier-shift.movement.create',
      idempotencyKey,
      request,
      async (tx) => {
        await this.assertActiveEmployee(tx, employeeId);
        const shift = await this.ledger.requireOpenShift(tx, employeeId);
        const amount = new Prisma.Decimal(dto.amount);
        if (dto.type === CashFlowType.EXPENSE) {
          const threshold = await this.getCashControlThreshold(
            tx,
            CashControlSettingKeys.EXPENSE_APPROVAL_THRESHOLD,
          );
          if (amount.gte(threshold)) {
            const expenseRequest = await tx.cashExpenseRequest.create({
              data: {
                amount,
                description: dto.description,
                requestedById: employeeId,
                shiftId: shift.id,
                fundId: shift.fundId,
              },
              include: this.expenseRequestInclude,
            });
            const fund = await tx.fund.findUniqueOrThrow({
              where: { id: shift.fundId },
              select: { balance: true },
            });
            await this.log(tx, employeeId, 'CASH_EXPENSE_REQUESTED', {
              requestId: expenseRequest.id,
              shiftId: shift.id,
              amount: amount.toString(),
            });
            return {
              movement: null,
              fundBalance: fund.balance,
              expenseRequest,
            };
          }
        }

        const result = await this.postMovement(tx, {
          shift,
          employeeId,
          type: dto.type,
          amount,
          description: dto.description,
        });
        await this.log(tx, employeeId, 'CASH_MOVEMENT_CREATED', {
          shiftId: shift.id,
          transactionId: result.movement.id,
          type: dto.type,
          amount: amount.toString(),
        });
        return { ...result, expenseRequest: null };
      },
    );
  }

  async approveExpenseRequest(
    id: string,
    employeeId: string,
    dto: ApproveCashExpenseRequestDto,
  ) {
    return this.runSerializable(async (tx) => {
      await this.assertActiveEmployee(tx, employeeId);
      const request = await this.findExpenseRequestOrThrow(tx, id);
      this.assertPendingExpenseRequest(request.status);
      if (request.requestedById === employeeId) {
        throw new ForbiddenException(
          'Employees cannot approve their own expense requests.',
        );
      }
      if (
        request.shift.status !== ShiftStatus.OPEN ||
        request.shift.fundId !== request.fundId ||
        request.fund.deletedAt !== null ||
        request.fund.type !== FundType.CASH
      ) {
        throw new ConflictException(
          'The expense request is no longer attached to an active cash shift.',
        );
      }

      const result = await this.postMovement(tx, {
        shift: { id: request.shiftId, fundId: request.fundId },
        employeeId: request.requestedById,
        type: CashFlowType.EXPENSE,
        amount: request.amount,
        description: request.description,
      });
      const resolvedAt = new Date();
      const approved = await tx.cashExpenseRequest.updateMany({
        where: { id, status: CashExpenseRequestStatus.PENDING },
        data: {
          status: CashExpenseRequestStatus.APPROVED,
          resolvedAt,
          resolvedById: employeeId,
          resolutionNote: dto.note,
          cashTransactionId: result.movement.id,
        },
      });
      if (approved.count !== 1) {
        throw new ConflictException(
          'Expense request has already been resolved.',
        );
      }
      await this.log(tx, employeeId, 'CASH_EXPENSE_APPROVED', {
        requestId: id,
        shiftId: request.shiftId,
        transactionId: result.movement.id,
        amount: request.amount.toString(),
      });
      return tx.cashExpenseRequest.findUniqueOrThrow({
        where: { id },
        include: this.expenseRequestInclude,
      });
    });
  }

  async rejectExpenseRequest(
    id: string,
    employeeId: string,
    dto: RejectCashExpenseRequestDto,
  ) {
    return this.resolveExpenseRequest({
      id,
      employeeId,
      status: CashExpenseRequestStatus.REJECTED,
      note: dto.reason,
      requireDifferentEmployee: true,
      actionType: 'CASH_EXPENSE_REJECTED',
    });
  }

  async cancelExpenseRequest(id: string, employeeId: string) {
    return this.resolveExpenseRequest({
      id,
      employeeId,
      status: CashExpenseRequestStatus.CANCELLED,
      note: 'Cancelled by requester',
      requireRequester: true,
      actionType: 'CASH_EXPENSE_CANCELLED',
    });
  }

  async close(employeeId: string, dto: CloseCashierShiftDto) {
    const { idempotencyKey, ...request } = dto;
    return this.executeMutation(
      employeeId,
      'cashier-shift.close',
      idempotencyKey,
      request,
      async (tx) => {
        await this.assertActiveEmployee(tx, employeeId);
        const shift = await tx.cashierShift.findFirst({
          where: { employeeId, status: ShiftStatus.OPEN },
          include: this.shiftInclude,
        });
        if (!shift) {
          throw new ConflictException('An open cashier shift is required.');
        }
        const pendingExpenseRequests = await tx.cashExpenseRequest.count({
          where: {
            shiftId: shift.id,
            status: CashExpenseRequestStatus.PENDING,
          },
        });
        if (pendingExpenseRequests > 0) {
          throw new ConflictException(
            'Cannot close a shift with pending expense requests.',
          );
        }
        const pendingPaymentAttempts = await tx.paymentAttempt.count({
          where: {
            shiftId: shift.id,
            status: {
              in: [
                PaymentAttemptStatus.PENDING,
                PaymentAttemptStatus.EXPIRED,
                PaymentAttemptStatus.REQUIRES_REVIEW,
              ],
            },
          },
        });
        if (pendingPaymentAttempts > 0) {
          throw new ConflictException(
            'Cannot close a shift with unresolved online payments.',
          );
        }
        const activeSessions = await tx.orderSession.count({
          where: { shiftId: shift.id, sessionStatus: SessionStatus.ACTIVE },
        });
        if (activeSessions > 0) {
          throw new ConflictException(
            'Cannot close a shift with active order sessions.',
          );
        }

        const reconciliation = await this.calculateReconciliation(tx, shift);
        const reportedEndingCash = new Prisma.Decimal(dto.reportedEndingCash);
        const difference = reportedEndingCash.minus(
          reconciliation.actualEndingCash,
        );
        const noteThreshold = await this.getCashControlThreshold(
          tx,
          CashControlSettingKeys.SHIFT_DISCREPANCY_NOTE_THRESHOLD,
        );
        if (
          !difference.isZero() &&
          difference.abs().gte(noteThreshold) &&
          !dto.closingNote
        ) {
          throw new BadRequestException(
            'A closing note is required for this cash discrepancy.',
          );
        }
        const closedAt = new Date();
        const closed = await tx.cashierShift.updateMany({
          where: { id: shift.id, status: ShiftStatus.OPEN },
          data: {
            status: ShiftStatus.CLOSED,
            closedAt,
            reportedEndingCash,
            actualEndingCash: reconciliation.actualEndingCash,
            closingNote: dto.closingNote,
          },
        });
        if (closed.count !== 1) {
          throw new ConflictException('Cashier shift has already been closed.');
        }

        await this.log(tx, employeeId, 'CASHIER_SHIFT_CLOSED', {
          shiftId: shift.id,
          reportedEndingCash: reportedEndingCash.toString(),
          actualEndingCash: reconciliation.actualEndingCash.toString(),
          difference: difference.toString(),
        });
        return {
          ...(await tx.cashierShift.findUniqueOrThrow({
            where: { id: shift.id },
            include: this.shiftInclude,
          })),
          reconciliation: {
            ...reconciliation,
            reportedEndingCash,
            difference,
          },
        };
      },
    );
  }

  private executeMutation<T>(
    employeeId: string,
    operation: string,
    idempotencyKey: string | undefined,
    request: unknown,
    callback: (tx: ExtendedPrismaTransactionClient) => Promise<T>,
  ) {
    return idempotencyKey
      ? this.idempotency.execute(
          { employeeId, operation, key: idempotencyKey, request },
          callback,
        )
      : this.runSerializable(callback);
  }

  private readonly shiftInclude = {
    employee: { select: { id: true, fullName: true } },
    fund: { select: { id: true, name: true, type: true, balance: true } },
  } as const;

  private readonly expenseRequestInclude = {
    requestedBy: { select: { id: true, fullName: true } },
    resolvedBy: { select: { id: true, fullName: true } },
    shift: { select: { id: true, status: true, openedAt: true } },
    fund: { select: { id: true, name: true, type: true } },
    cashTransaction: { select: { id: true, transactionDate: true } },
  } as const;

  private async withReconciliation<
    T extends {
      id: string;
      startingCash: Prisma.Decimal;
      expectedStartingCash: Prisma.Decimal;
      reportedEndingCash: Prisma.Decimal | null;
    },
  >(tx: ExtendedPrismaTransactionClient, shift: T) {
    const reconciliation = await this.calculateReconciliation(tx, shift);
    return {
      ...shift,
      reconciliation: {
        ...reconciliation,
        reportedEndingCash: shift.reportedEndingCash,
        difference:
          shift.reportedEndingCash !== null
            ? shift.reportedEndingCash.minus(reconciliation.actualEndingCash)
            : null,
      },
    };
  }

  private async calculateReconciliation(
    tx: ExtendedPrismaTransactionClient,
    shift: { id: string; expectedStartingCash: Prisma.Decimal },
  ) {
    const invoiceGroups = await tx.invoice.groupBy({
      by: ['paymentMethod'],
      where: {
        shiftId: shift.id,
        paymentStatus: {
          in: [
            PaymentStatus.PAID,
            PaymentStatus.PARTIALLY_REFUNDED,
            PaymentStatus.REFUNDED,
          ],
        },
      },
      _count: { _all: true },
      _sum: { totalAmount: true },
    });
    const refunds = await tx.paymentRefund.aggregate({
      where: {
        status: PaymentRefundStatus.SUCCEEDED,
        paymentAttempt: { shiftId: shift.id },
      },
      _sum: { amount: true },
    });
    const movementGroups = await tx.cashTransaction.groupBy({
      by: ['type'],
      where: { shiftId: shift.id, invoiceId: null },
      _sum: { amount: true },
    });

    const invoiceTotals = {
      paidInvoiceCount: invoiceGroups.reduce(
        (sum, group) => sum + group._count._all,
        0,
      ),
      cashSales: new Prisma.Decimal(0),
      nonCashSales: new Prisma.Decimal(0),
      totalSales: new Prisma.Decimal(0),
    };
    for (const group of invoiceGroups) {
      const amount = group._sum.totalAmount ?? new Prisma.Decimal(0);
      invoiceTotals.totalSales = invoiceTotals.totalSales.plus(amount);
      if (group.paymentMethod === PaymentMethod.CASH) {
        invoiceTotals.cashSales = invoiceTotals.cashSales.plus(amount);
      } else {
        invoiceTotals.nonCashSales = invoiceTotals.nonCashSales.plus(amount);
      }
    }
    const refundedAmount = refunds._sum.amount ?? new Prisma.Decimal(0);
    invoiceTotals.nonCashSales =
      invoiceTotals.nonCashSales.minus(refundedAmount);
    invoiceTotals.totalSales = invoiceTotals.totalSales.minus(refundedAmount);

    const manualTotals = {
      manualIncome: new Prisma.Decimal(0),
      manualExpense: new Prisma.Decimal(0),
    };
    for (const group of movementGroups) {
      const amount = group._sum.amount ?? new Prisma.Decimal(0);
      if (group.type === CashFlowType.INCOME) {
        manualTotals.manualIncome = manualTotals.manualIncome.plus(amount);
      } else {
        manualTotals.manualExpense = manualTotals.manualExpense.plus(amount);
      }
    }

    return {
      ...invoiceTotals,
      ...manualTotals,
      actualEndingCash: shift.expectedStartingCash
        .plus(invoiceTotals.cashSales)
        .plus(manualTotals.manualIncome)
        .minus(manualTotals.manualExpense),
    };
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

  private async postMovement(
    tx: ExtendedPrismaTransactionClient,
    input: {
      shift: { id: string; fundId: string };
      employeeId: string;
      type: CashFlowType;
      amount: Prisma.Decimal;
      description: string;
    },
  ) {
    const fundUpdate =
      input.type === CashFlowType.INCOME
        ? await tx.fund.updateMany({
            where: { id: input.shift.fundId, deletedAt: null },
            data: { balance: { increment: input.amount } },
          })
        : await tx.fund.updateMany({
            where: {
              id: input.shift.fundId,
              deletedAt: null,
              balance: { gte: input.amount },
            },
            data: { balance: { decrement: input.amount } },
          });
    if (fundUpdate.count !== 1) {
      throw new ConflictException('Insufficient fund balance.');
    }

    const movement = await tx.cashTransaction.create({
      data: {
        type: input.type,
        amount: input.amount,
        description: input.description,
        transactionDate: new Date(),
        fundId: input.shift.fundId,
        shiftId: input.shift.id,
        employeeId: input.employeeId,
      },
    });
    const fund = await tx.fund.findUniqueOrThrow({
      where: { id: input.shift.fundId },
      select: { balance: true },
    });
    return { movement, fundBalance: fund.balance };
  }

  private async resolveExpenseRequest(input: {
    id: string;
    employeeId: string;
    status:
      | typeof CashExpenseRequestStatus.REJECTED
      | typeof CashExpenseRequestStatus.CANCELLED;
    note: string;
    requireDifferentEmployee?: boolean;
    requireRequester?: boolean;
    actionType: string;
  }) {
    return this.runSerializable(async (tx) => {
      await this.assertActiveEmployee(tx, input.employeeId);
      const request = await this.findExpenseRequestOrThrow(tx, input.id);
      this.assertPendingExpenseRequest(request.status);
      if (
        input.requireDifferentEmployee &&
        request.requestedById === input.employeeId
      ) {
        throw new ForbiddenException(
          'Employees cannot review their own expense requests.',
        );
      }
      if (
        input.requireRequester &&
        request.requestedById !== input.employeeId
      ) {
        throw new ForbiddenException(
          'Only the requester can cancel this expense request.',
        );
      }

      const resolved = await tx.cashExpenseRequest.updateMany({
        where: { id: input.id, status: CashExpenseRequestStatus.PENDING },
        data: {
          status: input.status,
          resolvedAt: new Date(),
          resolvedById: input.employeeId,
          resolutionNote: input.note,
        },
      });
      if (resolved.count !== 1) {
        throw new ConflictException(
          'Expense request has already been resolved.',
        );
      }
      await this.log(tx, input.employeeId, input.actionType, {
        requestId: input.id,
        shiftId: request.shiftId,
        amount: request.amount.toString(),
      });
      return tx.cashExpenseRequest.findUniqueOrThrow({
        where: { id: input.id },
        include: this.expenseRequestInclude,
      });
    });
  }

  private async findExpenseRequestOrThrow(
    tx: ExtendedPrismaTransactionClient,
    id: string,
  ) {
    const request = await tx.cashExpenseRequest.findUnique({
      where: { id },
      include: {
        shift: { select: { id: true, status: true, fundId: true } },
        fund: { select: { id: true, type: true, deletedAt: true } },
      },
    });
    if (!request) {
      throw new NotFoundException(
        `Cash expense request with ID ${id} not found.`,
      );
    }
    return request;
  }

  private assertPendingExpenseRequest(status: CashExpenseRequestStatus) {
    if (status !== CashExpenseRequestStatus.PENDING) {
      throw new ConflictException('Expense request has already been resolved.');
    }
  }

  private async getCashControlThreshold(
    tx: ExtendedPrismaTransactionClient,
    key: string,
  ) {
    const setting = await tx.systemSetting.findFirst({
      where: {
        key,
        valueType: SettingValueType.NUMBER,
        deletedAt: null,
      },
      select: { value: true },
    });
    const value = setting?.value;
    return typeof value === 'number' && Number.isFinite(value) && value >= 0
      ? new Prisma.Decimal(value)
      : new Prisma.Decimal(0);
  }

  private async log(
    tx: ExtendedPrismaTransactionClient,
    employeeId: string,
    actionType: string,
    details: Prisma.InputJsonObject,
  ) {
    await tx.actionLog.create({ data: { employeeId, actionType, details } });
  }

  private async runSerializable<T>(
    callback: (tx: ExtendedPrismaTransactionClient) => Promise<T>,
  ): Promise<T> {
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        return await this.prisma.$transaction(callback, {
          isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
        });
      } catch (error) {
        const retryable =
          error instanceof Prisma.PrismaClientKnownRequestError &&
          error.code === 'P2034';
        if (!retryable || attempt === 3) throw error;
        this.logger.warn(
          `Cashier shift transaction conflict. Retrying ${attempt + 1}/3`,
        );
        await new Promise((resolve) => setTimeout(resolve, attempt * 25));
      }
    }
    throw new ConflictException('Transaction failed. Please try again.');
  }
}
