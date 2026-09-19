import {
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import {
  CashFlowType,
  FundType,
  PaymentMethod,
  PaymentStatus,
  Prisma,
  SessionStatus,
  ShiftStatus,
} from '@prisma/client';
import {
  PRISMA_SERVICE_TOKEN,
  type ExtendedPrismaClient,
} from '../../common/prisma/prisma.service';
import type { ExtendedPrismaTransactionClient } from '../../common/types';
import { PaginationUtilService } from '../../common/utils/pagination-util/pagination-util.service';
import { CashierShiftLedgerService } from './cashier-shift-ledger.service';
import {
  CloseCashierShiftDto,
  CreateCashMovementDto,
  GetCashierShiftsDto,
  OpenCashierShiftDto,
} from './dto';

@Injectable()
export class CashierShiftsService {
  private readonly logger = new Logger(CashierShiftsService.name);

  constructor(
    @Inject(PRISMA_SERVICE_TOKEN)
    private readonly prisma: ExtendedPrismaClient,
    private readonly paginationUtil: PaginationUtilService,
    private readonly ledger: CashierShiftLedgerService,
  ) {}

  async open(employeeId: string, dto: OpenCashierShiftDto) {
    try {
      return await this.runSerializable(async (tx) => {
        await this.assertActiveEmployee(tx, employeeId);
        const fund = await tx.fund.findFirst({
          where: { id: dto.fundId, deletedAt: null },
          select: { id: true, type: true },
        });
        if (!fund) {
          throw new NotFoundException(`Fund with ID ${dto.fundId} not found.`);
        }
        if (fund.type !== FundType.CASH) {
          throw new ConflictException('Cashier shifts require a CASH fund.');
        }

        const shift = await tx.cashierShift.create({
          data: {
            employeeId,
            fundId: fund.id,
            startingCash: new Prisma.Decimal(dto.startingCash),
          },
          include: this.shiftInclude,
        });
        await this.log(tx, employeeId, 'CASHIER_SHIFT_OPENED', {
          shiftId: shift.id,
          fundId: fund.id,
          startingCash: shift.startingCash.toString(),
        });
        return shift;
      });
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

  async addMovement(employeeId: string, dto: CreateCashMovementDto) {
    return this.runSerializable(async (tx) => {
      await this.assertActiveEmployee(tx, employeeId);
      const shift = await this.ledger.requireOpenShift(tx, employeeId);
      const amount = new Prisma.Decimal(dto.amount);
      const fundUpdate =
        dto.type === CashFlowType.INCOME
          ? await tx.fund.updateMany({
              where: { id: shift.fundId, deletedAt: null },
              data: { balance: { increment: amount } },
            })
          : await tx.fund.updateMany({
              where: {
                id: shift.fundId,
                deletedAt: null,
                balance: { gte: amount },
              },
              data: { balance: { decrement: amount } },
            });
      if (fundUpdate.count !== 1) {
        throw new ConflictException('Insufficient fund balance.');
      }

      const movement = await tx.cashTransaction.create({
        data: {
          type: dto.type,
          amount,
          description: dto.description,
          transactionDate: new Date(),
          fundId: shift.fundId,
          shiftId: shift.id,
          employeeId,
        },
      });
      const fund = await tx.fund.findUniqueOrThrow({
        where: { id: shift.fundId },
        select: { balance: true },
      });
      await this.log(tx, employeeId, 'CASH_MOVEMENT_CREATED', {
        shiftId: shift.id,
        transactionId: movement.id,
        type: dto.type,
        amount: amount.toString(),
      });
      return { movement, fundBalance: fund.balance };
    });
  }

  async close(employeeId: string, dto: CloseCashierShiftDto) {
    return this.runSerializable(async (tx) => {
      await this.assertActiveEmployee(tx, employeeId);
      const shift = await tx.cashierShift.findFirst({
        where: { employeeId, status: ShiftStatus.OPEN },
        include: this.shiftInclude,
      });
      if (!shift) {
        throw new ConflictException('An open cashier shift is required.');
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
        difference: reportedEndingCash
          .minus(reconciliation.actualEndingCash)
          .toString(),
      });
      return {
        ...(await tx.cashierShift.findUniqueOrThrow({
          where: { id: shift.id },
          include: this.shiftInclude,
        })),
        reconciliation: {
          ...reconciliation,
          reportedEndingCash,
          difference: reportedEndingCash.minus(reconciliation.actualEndingCash),
        },
      };
    });
  }

  private readonly shiftInclude = {
    employee: { select: { id: true, fullName: true } },
    fund: { select: { id: true, name: true, type: true, balance: true } },
  } as const;

  private async withReconciliation<
    T extends {
      id: string;
      startingCash: Prisma.Decimal;
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
    shift: { id: string; startingCash: Prisma.Decimal },
  ) {
    const invoiceGroups = await tx.invoice.groupBy({
      by: ['paymentMethod'],
      where: { shiftId: shift.id, paymentStatus: PaymentStatus.PAID },
      _count: { _all: true },
      _sum: { totalAmount: true },
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
      actualEndingCash: shift.startingCash
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
