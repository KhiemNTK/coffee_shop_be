import { ConflictException, Injectable } from '@nestjs/common';
import { CashFlowType, FundType, Prisma, ShiftStatus } from '@prisma/client';
import type {
  ExtendedPrismaTransactionClient,
  OpenCashierShiftContext,
} from '../../common/types';

@Injectable()
export class CashierShiftLedgerService {
  async findOpenShiftId(
    tx: ExtendedPrismaTransactionClient,
    employeeId: string,
  ) {
    const shift = await tx.cashierShift.findFirst({
      where: { employeeId, status: ShiftStatus.OPEN },
      select: { id: true },
    });
    return shift?.id ?? null;
  }

  async requireOpenShift(
    tx: ExtendedPrismaTransactionClient,
    employeeId: string,
  ): Promise<OpenCashierShiftContext> {
    const shift = await tx.cashierShift.findFirst({
      where: { employeeId, status: ShiftStatus.OPEN },
      select: {
        id: true,
        fundId: true,
        fund: { select: { type: true, deletedAt: true } },
      },
    });

    if (!shift) {
      throw new ConflictException('An open cashier shift is required.');
    }
    if (
      !shift.fundId ||
      !shift.fund ||
      shift.fund.deletedAt ||
      shift.fund.type !== FundType.CASH
    ) {
      throw new ConflictException(
        'The open shift must use an active CASH fund.',
      );
    }

    return { id: shift.id, fundId: shift.fundId };
  }

  async recordCashInvoice(
    tx: ExtendedPrismaTransactionClient,
    input: {
      shift: OpenCashierShiftContext;
      invoiceId: string;
      invoiceNumber: string;
      employeeId: string;
      amount: Prisma.Decimal;
    },
  ) {
    await tx.cashTransaction.create({
      data: {
        type: CashFlowType.INCOME,
        amount: input.amount,
        description: `Cash payment for invoice ${input.invoiceNumber}`,
        transactionDate: new Date(),
        fundId: input.shift.fundId,
        shiftId: input.shift.id,
        employeeId: input.employeeId,
        invoiceId: input.invoiceId,
      },
    });
    await tx.fund.update({
      where: { id: input.shift.fundId },
      data: { balance: { increment: input.amount } },
    });
  }
}
