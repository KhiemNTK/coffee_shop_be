import {
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import {
  CashFlowType,
  CashHandoverSettlementStatus,
  CashHandoverStatus,
  FundType,
  Prisma,
  SettingValueType,
  ShiftStatus,
} from '@prisma/client';
import {
  CashControlSettingDefaults,
  CashControlSettingKeys,
} from '../../common/consts/cash-control-settings';
import {
  PRISMA_SERVICE_TOKEN,
  type ExtendedPrismaClient,
} from '../../common/prisma/prisma.service';
import type { ExtendedPrismaTransactionClient } from '../../common/types';
import { PaginationUtilService } from '../../common/utils/pagination-util/pagination-util.service';
import {
  ApproveCashHandoverDto,
  CreateCashHandoverDto,
  GetCashHandoversDto,
  GetOverdueCashHandoversDto,
  RegisterBankDepositDto,
  RejectCashHandoverDto,
  SettleCashHandoverDto,
} from './dto';

@Injectable()
export class CashHandoversService {
  private readonly logger = new Logger(CashHandoversService.name);

  constructor(
    @Inject(PRISMA_SERVICE_TOKEN)
    private readonly prisma: ExtendedPrismaClient,
    private readonly paginationUtil: PaginationUtilService,
  ) {}

  async create(employeeId: string, dto: CreateCashHandoverDto) {
    try {
      return await this.runSerializable(async (tx) => {
        await this.assertActiveEmployee(tx, employeeId);
        const shift = await tx.cashierShift.findUnique({
          where: { id: dto.shiftId },
          select: {
            id: true,
            employeeId: true,
            status: true,
            fundId: true,
            actualEndingCash: true,
            reportedEndingCash: true,
            fund: {
              select: {
                id: true,
                type: true,
                balance: true,
                deletedAt: true,
              },
            },
          },
        });
        if (!shift) {
          throw new NotFoundException(
            `Cashier shift with ID ${dto.shiftId} not found.`,
          );
        }
        if (shift.employeeId !== employeeId) {
          throw new ForbiddenException(
            'Only the cashier responsible for the shift can request its handover.',
          );
        }
        if (
          shift.status !== ShiftStatus.CLOSED ||
          !shift.fundId ||
          !shift.fund ||
          !shift.actualEndingCash ||
          !shift.reportedEndingCash
        ) {
          throw new ConflictException(
            'Only a reconciled closed shift can be handed over.',
          );
        }
        if (shift.fund.deletedAt || shift.fund.type !== FundType.CASH) {
          throw new ConflictException(
            'The source must be an active CASH fund.',
          );
        }
        if (shift.fundId === dto.destinationFundId) {
          throw new ConflictException(
            'Source and destination funds must be different.',
          );
        }

        const [destinationFund, openShift] = await Promise.all([
          tx.fund.findFirst({
            where: { id: dto.destinationFundId, deletedAt: null },
            select: { id: true },
          }),
          tx.cashierShift.findFirst({
            where: { fundId: shift.fundId, status: ShiftStatus.OPEN },
            select: { id: true },
          }),
        ]);
        if (!destinationFund) {
          throw new NotFoundException(
            `Destination fund with ID ${dto.destinationFundId} not found.`,
          );
        }
        if (openShift) {
          throw new ConflictException(
            'Cannot request a handover while the source fund has an open shift.',
          );
        }
        if (!shift.fund.balance.equals(shift.actualEndingCash)) {
          throw new ConflictException(
            'The source fund balance changed after the shift closed.',
          );
        }

        const retainedCash = new Prisma.Decimal(dto.retainedCash);
        if (retainedCash.greaterThanOrEqualTo(shift.reportedEndingCash)) {
          throw new ConflictException(
            'Retained cash must be lower than the counted ending cash.',
          );
        }
        const varianceAmount = shift.reportedEndingCash.minus(
          shift.actualEndingCash,
        );
        const transferAmount = shift.reportedEndingCash.minus(retainedCash);
        const handover = await tx.cashHandover.create({
          data: {
            shiftId: shift.id,
            sourceFundId: shift.fundId,
            destinationFundId: destinationFund.id,
            requestedById: employeeId,
            expectedCash: shift.actualEndingCash,
            countedCash: shift.reportedEndingCash,
            varianceAmount,
            retainedCash,
            transferAmount,
            note: dto.note,
          },
          include: this.handoverInclude,
        });
        await this.log(tx, employeeId, 'CASH_HANDOVER_REQUESTED', {
          handoverId: handover.id,
          shiftId: shift.id,
          sourceFundId: shift.fundId,
          destinationFundId: destinationFund.id,
          expectedCash: shift.actualEndingCash.toString(),
          countedCash: shift.reportedEndingCash.toString(),
          retainedCash: retainedCash.toString(),
          transferAmount: transferAmount.toString(),
        });
        return handover;
      });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        throw new ConflictException(
          'This shift already has a pending or approved handover.',
        );
      }
      throw error;
    }
  }

  async findAll(query: GetCashHandoversDto, requestedById?: string) {
    const where: Prisma.CashHandoverWhereInput = {
      ...(query.status ? { status: query.status } : {}),
      ...(query.settlementStatus
        ? { settlementStatus: query.settlementStatus }
        : {}),
      ...(query.shiftId ? { shiftId: query.shiftId } : {}),
      ...(query.sourceFundId ? { sourceFundId: query.sourceFundId } : {}),
      ...(query.destinationFundId
        ? { destinationFundId: query.destinationFundId }
        : {}),
      ...(requestedById
        ? { requestedById }
        : query.requestedById
          ? { requestedById: query.requestedById }
          : {}),
      ...(query.createdFrom || query.createdTo
        ? {
            createdAt: {
              ...(query.createdFrom ? { gte: query.createdFrom } : {}),
              ...(query.createdTo ? { lt: query.createdTo } : {}),
            },
          }
        : {}),
    };
    return this.paginate(where, query);
  }

  findOverdue(query: GetOverdueCashHandoversDto) {
    return this.paginate(
      {
        status: CashHandoverStatus.APPROVED,
        settlementStatus: CashHandoverSettlementStatus.PENDING,
        settlementDueAt: { lt: new Date() },
      },
      query,
    );
  }

  async findOne(id: string) {
    const handover = await this.prisma.cashHandover.findUnique({
      where: { id },
      include: this.handoverInclude,
    });
    if (!handover) {
      throw new NotFoundException(`Cash handover with ID ${id} not found.`);
    }
    return handover;
  }

  async approve(id: string, employeeId: string, dto: ApproveCashHandoverDto) {
    return this.runSerializable(async (tx) => {
      await this.assertActiveEmployee(tx, employeeId);
      const handover = await this.findOrThrow(tx, id);
      this.assertPending(handover.status);
      if (handover.requestedById === employeeId) {
        throw new ForbiddenException(
          'Employees cannot approve their own cash handovers.',
        );
      }
      if (
        handover.sourceFund.deletedAt ||
        handover.sourceFund.type !== FundType.CASH ||
        handover.destinationFund.deletedAt
      ) {
        throw new ConflictException(
          'Both handover funds must remain active and the source must be CASH.',
        );
      }

      const openShift = await tx.cashierShift.findFirst({
        where: {
          fundId: handover.sourceFundId,
          status: ShiftStatus.OPEN,
        },
        select: { id: true },
      });
      if (openShift) {
        throw new ConflictException(
          'Cannot approve a handover while the source fund has an open shift.',
        );
      }

      const sourceUpdate = await tx.fund.updateMany({
        where: {
          id: handover.sourceFundId,
          deletedAt: null,
          balance: handover.expectedCash,
        },
        data: { balance: handover.retainedCash },
      });
      if (sourceUpdate.count !== 1) {
        throw new ConflictException(
          'The source fund balance changed after the handover was requested.',
        );
      }

      const resolvedAt = new Date();
      const requiresSettlement =
        handover.destinationFund.type === FundType.BANK;
      const settlementDueAt = requiresSettlement
        ? new Date(
            resolvedAt.getTime() +
              (await this.getSettlementSlaHours(tx)) * 60 * 60 * 1000,
          )
        : null;
      const varianceTransaction = handover.varianceAmount.isZero()
        ? null
        : await tx.cashTransaction.create({
            data: {
              type: handover.varianceAmount.isPositive()
                ? CashFlowType.INCOME
                : CashFlowType.EXPENSE,
              amount: handover.varianceAmount.abs(),
              description: `Cash variance adjustment for handover ${handover.id}`,
              transactionDate: resolvedAt,
              fundId: handover.sourceFundId,
              employeeId,
            },
          });
      const sourceTransaction = await tx.cashTransaction.create({
        data: {
          type: CashFlowType.EXPENSE,
          amount: handover.transferAmount,
          description: `Outgoing cash handover ${handover.id}`,
          transactionDate: resolvedAt,
          fundId: handover.sourceFundId,
          employeeId,
        },
      });
      const destinationTransaction = requiresSettlement
        ? null
        : await this.postDestinationEntry(
            tx,
            handover,
            employeeId,
            resolvedAt,
            handover.destinationFund.type,
          );

      const approved = await tx.cashHandover.update({
        where: { id: handover.id },
        data: {
          status: CashHandoverStatus.APPROVED,
          resolvedAt,
          resolvedById: employeeId,
          resolutionNote: dto.note,
          settlementStatus: requiresSettlement
            ? CashHandoverSettlementStatus.PENDING
            : CashHandoverSettlementStatus.NOT_REQUIRED,
          settlementDueAt,
          sourceTransactionId: sourceTransaction.id,
          destinationTransactionId: destinationTransaction?.id,
          varianceTransactionId: varianceTransaction?.id,
        },
        include: this.handoverInclude,
      });
      await this.log(tx, employeeId, 'CASH_HANDOVER_APPROVED', {
        handoverId: handover.id,
        shiftId: handover.shiftId,
        sourceTransactionId: sourceTransaction.id,
        destinationTransactionId: destinationTransaction?.id ?? null,
        varianceTransactionId: varianceTransaction?.id ?? null,
        settlementStatus: approved.settlementStatus,
        settlementDueAt: approved.settlementDueAt?.toISOString() ?? null,
        transferAmount: handover.transferAmount.toString(),
      });
      return approved;
    });
  }

  async settle(id: string, employeeId: string, dto: SettleCashHandoverDto) {
    try {
      return await this.runSerializable(async (tx) => {
        await this.assertActiveEmployee(tx, employeeId);
        const handover = await this.findOrThrow(tx, id);
        if (
          handover.status !== CashHandoverStatus.APPROVED ||
          handover.settlementStatus !== CashHandoverSettlementStatus.PENDING
        ) {
          throw new ConflictException(
            'The cash handover is not awaiting bank settlement.',
          );
        }
        if (handover.requestedById === employeeId) {
          throw new ForbiddenException(
            'Employees cannot settle their own cash handovers.',
          );
        }
        if (
          handover.destinationFund.deletedAt ||
          handover.destinationFund.type !== FundType.BANK
        ) {
          throw new ConflictException(
            'Settlement requires an active BANK destination fund.',
          );
        }

        const bankReference = dto.bankReference.toUpperCase();
        if (
          (handover.bankReference &&
            handover.bankReference !== bankReference) ||
          (handover.evidenceReference &&
            handover.evidenceReference !== dto.evidenceReference)
        ) {
          throw new ConflictException(
            'Settlement details do not match the registered bank deposit.',
          );
        }

        const settledAt = new Date();
        const destinationTransaction = await this.postDestinationEntry(
          tx,
          handover,
          employeeId,
          settledAt,
          FundType.BANK,
        );
        const settled = await tx.cashHandover.update({
          where: { id: handover.id },
          data: {
            settlementStatus: CashHandoverSettlementStatus.SETTLED,
            settledAt,
            settledById: employeeId,
            bankReference,
            evidenceReference: dto.evidenceReference,
            destinationTransactionId: destinationTransaction.id,
          },
          include: this.handoverInclude,
        });
        await this.log(tx, employeeId, 'CASH_HANDOVER_SETTLED', {
          handoverId: handover.id,
          destinationFundId: handover.destinationFundId,
          destinationTransactionId: destinationTransaction.id,
          bankReference: settled.bankReference,
          evidenceReference: settled.evidenceReference,
          transferAmount: handover.transferAmount.toString(),
        });
        return settled;
      });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        throw new ConflictException(
          'This bank reference has already been reconciled for the destination fund.',
        );
      }
      throw error;
    }
  }

  async registerDeposit(
    id: string,
    employeeId: string,
    dto: RegisterBankDepositDto,
  ) {
    try {
      return await this.runSerializable(async (tx) => {
        await this.assertActiveEmployee(tx, employeeId);
        const handover = await this.findOrThrow(tx, id);
        if (
          handover.status !== CashHandoverStatus.APPROVED ||
          handover.settlementStatus !== CashHandoverSettlementStatus.PENDING
        ) {
          throw new ConflictException(
            'Only an approved handover awaiting bank settlement can register a deposit.',
          );
        }
        if (handover.requestedById !== employeeId) {
          throw new ForbiddenException(
            'Only the handover requester can register the bank deposit evidence.',
          );
        }
        if (
          handover.destinationFund.deletedAt ||
          handover.destinationFund.type !== FundType.BANK
        ) {
          throw new ConflictException(
            'Deposit registration requires an active BANK destination fund.',
          );
        }

        const bankReference = dto.bankReference.toUpperCase();
        if (handover.bankReference || handover.evidenceReference) {
          if (
            handover.bankReference === bankReference &&
            handover.evidenceReference === dto.evidenceReference
          ) {
            return tx.cashHandover.findUniqueOrThrow({
              where: { id: handover.id },
              include: this.handoverInclude,
            });
          }
          throw new ConflictException(
            'Bank deposit evidence has already been registered.',
          );
        }

        const registered = await tx.cashHandover.update({
          where: { id: handover.id },
          data: {
            bankReference,
            evidenceReference: dto.evidenceReference,
          },
          include: this.handoverInclude,
        });
        await this.log(tx, employeeId, 'CASH_HANDOVER_DEPOSIT_REGISTERED', {
          handoverId: handover.id,
          destinationFundId: handover.destinationFundId,
          bankReference,
          evidenceReference: dto.evidenceReference,
          transferAmount: handover.transferAmount.toString(),
        });
        return registered;
      });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        throw new ConflictException(
          'This bank reference is already registered for the destination fund.',
        );
      }
      throw error;
    }
  }

  async reject(id: string, employeeId: string, dto: RejectCashHandoverDto) {
    return this.runSerializable(async (tx) => {
      await this.assertActiveEmployee(tx, employeeId);
      const handover = await this.findOrThrow(tx, id);
      this.assertPending(handover.status);
      if (handover.requestedById === employeeId) {
        throw new ForbiddenException(
          'Employees cannot reject their own cash handovers.',
        );
      }
      const rejected = await tx.cashHandover.update({
        where: { id: handover.id },
        data: {
          status: CashHandoverStatus.REJECTED,
          resolvedAt: new Date(),
          resolvedById: employeeId,
          resolutionNote: dto.reason,
        },
        include: this.handoverInclude,
      });
      await this.log(tx, employeeId, 'CASH_HANDOVER_REJECTED', {
        handoverId: handover.id,
        shiftId: handover.shiftId,
        reason: dto.reason,
      });
      return rejected;
    });
  }

  async cancel(id: string, employeeId: string) {
    return this.runSerializable(async (tx) => {
      await this.assertActiveEmployee(tx, employeeId);
      const handover = await this.findOrThrow(tx, id);
      this.assertPending(handover.status);
      if (handover.requestedById !== employeeId) {
        throw new ForbiddenException(
          'Only the requester can cancel this cash handover.',
        );
      }
      const cancelled = await tx.cashHandover.update({
        where: { id: handover.id },
        data: {
          status: CashHandoverStatus.CANCELLED,
          resolvedAt: new Date(),
          resolvedById: employeeId,
          resolutionNote: 'Cancelled by requester',
        },
        include: this.handoverInclude,
      });
      await this.log(tx, employeeId, 'CASH_HANDOVER_CANCELLED', {
        handoverId: handover.id,
        shiftId: handover.shiftId,
      });
      return cancelled;
    });
  }

  private readonly handoverInclude = {
    requestedBy: { select: { id: true, fullName: true } },
    resolvedBy: { select: { id: true, fullName: true } },
    settledBy: { select: { id: true, fullName: true } },
    shift: {
      select: {
        id: true,
        openedAt: true,
        closedAt: true,
        reportedEndingCash: true,
        actualEndingCash: true,
      },
    },
    sourceFund: { select: { id: true, name: true, type: true } },
    destinationFund: { select: { id: true, name: true, type: true } },
    sourceTransaction: {
      select: { id: true, type: true, amount: true, transactionDate: true },
    },
    destinationTransaction: {
      select: { id: true, type: true, amount: true, transactionDate: true },
    },
    varianceTransaction: {
      select: { id: true, type: true, amount: true, transactionDate: true },
    },
  } as const;

  private async findOrThrow(tx: ExtendedPrismaTransactionClient, id: string) {
    const handover = await tx.cashHandover.findUnique({
      where: { id },
      include: {
        sourceFund: {
          select: { id: true, type: true, balance: true, deletedAt: true },
        },
        destinationFund: {
          select: { id: true, type: true, deletedAt: true },
        },
      },
    });
    if (!handover) {
      throw new NotFoundException(`Cash handover with ID ${id} not found.`);
    }
    return handover;
  }

  private async paginate(
    where: Prisma.CashHandoverWhereInput,
    query: { itemPerPage: number; page: number },
  ) {
    const totalItems = await this.prisma.cashHandover.count({ where });
    const paging = this.paginationUtil.paging({ ...query, totalItems });
    const handovers = await this.prisma.cashHandover.findMany({
      where,
      skip: paging.skip,
      take: paging.itemPerPage,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      include: this.handoverInclude,
    });
    return paging.format(handovers);
  }

  private async postDestinationEntry(
    tx: ExtendedPrismaTransactionClient,
    handover: {
      id: string;
      destinationFundId: string;
      transferAmount: Prisma.Decimal;
    },
    employeeId: string,
    transactionDate: Date,
    expectedFundType: FundType,
  ) {
    const destinationUpdate = await tx.fund.updateMany({
      where: {
        id: handover.destinationFundId,
        type: expectedFundType,
        deletedAt: null,
      },
      data: { balance: { increment: handover.transferAmount } },
    });
    if (destinationUpdate.count !== 1) {
      throw new ConflictException('The destination fund is unavailable.');
    }
    return tx.cashTransaction.create({
      data: {
        type: CashFlowType.INCOME,
        amount: handover.transferAmount,
        description: `Incoming cash handover ${handover.id}`,
        transactionDate,
        fundId: handover.destinationFundId,
        employeeId,
      },
    });
  }

  private async getSettlementSlaHours(tx: ExtendedPrismaTransactionClient) {
    const setting = await tx.systemSetting.findFirst({
      where: {
        key: CashControlSettingKeys.HANDOVER_SETTLEMENT_SLA_HOURS,
        valueType: SettingValueType.NUMBER,
        deletedAt: null,
      },
      select: { value: true },
    });
    const value = setting?.value;
    return typeof value === 'number' &&
      Number.isInteger(value) &&
      value > 0 &&
      value <= 720
      ? value
      : CashControlSettingDefaults.HANDOVER_SETTLEMENT_SLA_HOURS;
  }

  private assertPending(status: CashHandoverStatus) {
    if (status !== CashHandoverStatus.PENDING) {
      throw new ConflictException('The cash handover is no longer pending.');
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
          `Cash handover transaction conflict. Retrying ${attempt + 1}/3`,
        );
        await new Promise((resolve) => setTimeout(resolve, attempt * 25));
      }
    }
    throw new ConflictException('Transaction failed. Please try again.');
  }
}
