import { randomUUID } from 'node:crypto';
import { ConflictException } from '@nestjs/common';
import {
  CashFlowType,
  CashHandoverSettlementStatus,
  CashHandoverStatus,
  FundType,
  Prisma,
  PrismaClient,
  ShiftStatus,
} from '@prisma/client';
import { CashHandoversService } from '../src/app/cashier-shifts/cash-handovers.service';
import type { ExtendedPrismaClient } from '../src/common/prisma/prisma.service';
import { PaginationUtilService } from '../src/common/utils/pagination-util/pagination-util.service';

describe('Cash handover ledger (e2e)', () => {
  const prisma = new PrismaClient();
  const service = new CashHandoversService(
    prisma as unknown as ExtendedPrismaClient,
    new PaginationUtilService(),
  );
  const suffix = randomUUID();

  let positionId: string;
  let requesterId: string;
  let reviewerId: string;
  const fundIds: string[] = [];
  const shiftIds: string[] = [];

  const createClosedShift = async (input: {
    sourceBalance: string;
    countedCash: string;
    destinationType?: FundType;
    destinationFundId?: string;
  }) => {
    const sourceFund = await prisma.fund.create({
      data: {
        name: `Handover Source ${randomUUID()} ${suffix}`,
        type: FundType.CASH,
        balance: new Prisma.Decimal(input.sourceBalance),
      },
    });
    fundIds.push(sourceFund.id);
    const destinationFund = input.destinationFundId
      ? await prisma.fund.findUniqueOrThrow({
          where: { id: input.destinationFundId },
        })
      : await prisma.fund.create({
          data: {
            name: `Handover Destination ${randomUUID()} ${suffix}`,
            type: input.destinationType ?? FundType.CASH,
          },
        });
    if (!input.destinationFundId) fundIds.push(destinationFund.id);
    const closedAt = new Date();
    const shift = await prisma.cashierShift.create({
      data: {
        employeeId: requesterId,
        fundId: sourceFund.id,
        status: ShiftStatus.CLOSED,
        openedAt: new Date(closedAt.getTime() - 8 * 60 * 60 * 1000),
        closedAt,
        startingCash: new Prisma.Decimal(input.sourceBalance),
        expectedStartingCash: new Prisma.Decimal(input.sourceBalance),
        openingDifference: new Prisma.Decimal(0),
        actualEndingCash: new Prisma.Decimal(input.sourceBalance),
        reportedEndingCash: new Prisma.Decimal(input.countedCash),
      },
    });
    shiftIds.push(shift.id);
    return { shift, sourceFund, destinationFund };
  };

  beforeAll(async () => {
    const position = await prisma.position.create({
      data: { name: `Handover Position ${suffix}`, salary: 0 },
    });
    positionId = position.id;
    const [requester, reviewer] = await Promise.all([
      prisma.employee.create({
        data: {
          email: `handover-requester-${suffix}@example.com`,
          username: `handover-requester-${suffix}`,
          fullName: 'Handover Requester',
          password: 'not-used-in-handover-tests',
          positionId,
        },
      }),
      prisma.employee.create({
        data: {
          email: `handover-reviewer-${suffix}@example.com`,
          username: `handover-reviewer-${suffix}`,
          fullName: 'Handover Reviewer',
          password: 'not-used-in-handover-tests',
          positionId,
        },
      }),
    ]);
    requesterId = requester.id;
    reviewerId = reviewer.id;
  });

  afterAll(async () => {
    try {
      const employeeIds = [requesterId, reviewerId].filter(Boolean);
      await prisma.cashHandover.deleteMany({
        where: { requestedById: { in: employeeIds } },
      });
      await prisma.cashTransaction.deleteMany({
        where: { employeeId: { in: employeeIds } },
      });
      await prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(
          "SET LOCAL app.allow_audit_log_mutation = 'on'",
        );
        await tx.actionLog.deleteMany({
          where: { employeeId: { in: employeeIds } },
        });
      });
      await prisma.cashierShift.deleteMany({
        where: { id: { in: shiftIds } },
      });
      await prisma.fund.deleteMany({ where: { id: { in: fundIds } } });
      await prisma.employee.deleteMany({
        where: { id: { in: employeeIds } },
      });
      if (positionId) {
        await prisma.position.deleteMany({ where: { id: positionId } });
      }
    } finally {
      await prisma.$disconnect();
    }
  });

  it('reconciles the physical variance and transfers cash atomically', async () => {
    const { shift, sourceFund, destinationFund } = await createClosedShift({
      sourceBalance: '100',
      countedCash: '90',
    });
    const pending = await service.create(requesterId, {
      shiftId: shift.id,
      destinationFundId: destinationFund.id,
      retainedCash: '20',
      note: 'End-of-day deposit',
    });

    const approved = await service.approve(pending.id, reviewerId, {
      note: 'Cash counted and received',
    });

    expect(approved.status).toBe(CashHandoverStatus.APPROVED);
    expect(approved.varianceTransaction).toEqual(
      expect.objectContaining({
        type: CashFlowType.EXPENSE,
        amount: new Prisma.Decimal('10'),
      }),
    );
    expect(approved.sourceTransaction).toEqual(
      expect.objectContaining({
        type: CashFlowType.EXPENSE,
        amount: new Prisma.Decimal('70'),
      }),
    );
    expect(approved.destinationTransaction).toEqual(
      expect.objectContaining({
        type: CashFlowType.INCOME,
        amount: new Prisma.Decimal('70'),
      }),
    );
    const [sourceAfter, destinationAfter] = await Promise.all([
      prisma.fund.findUniqueOrThrow({ where: { id: sourceFund.id } }),
      prisma.fund.findUniqueOrThrow({ where: { id: destinationFund.id } }),
    ]);
    expect(sourceAfter.balance.toString()).toBe('20');
    expect(destinationAfter.balance.toString()).toBe('70');
  });

  it('posts one transfer when two approvals race', async () => {
    const { shift, sourceFund, destinationFund } = await createClosedShift({
      sourceBalance: '200',
      countedCash: '200',
    });
    const pending = await service.create(requesterId, {
      shiftId: shift.id,
      destinationFundId: destinationFund.id,
      retainedCash: '50',
    });

    const results = await Promise.allSettled([
      service.approve(pending.id, reviewerId, {}),
      service.approve(pending.id, reviewerId, {}),
    ]);

    expect(results.filter(({ status }) => status === 'fulfilled')).toHaveLength(
      1,
    );
    expect(results.filter(({ status }) => status === 'rejected')).toHaveLength(
      1,
    );
    const [sourceAfter, destinationAfter, transferEntries] = await Promise.all([
      prisma.fund.findUniqueOrThrow({ where: { id: sourceFund.id } }),
      prisma.fund.findUniqueOrThrow({ where: { id: destinationFund.id } }),
      prisma.cashTransaction.findMany({
        where: {
          OR: [{ fundId: sourceFund.id }, { fundId: destinationFund.id }],
        },
      }),
    ]);
    expect(sourceAfter.balance.toString()).toBe('50');
    expect(destinationAfter.balance.toString()).toBe('150');
    expect(transferEntries).toHaveLength(2);
  });

  it('allows a corrected request after rejection', async () => {
    const { shift, destinationFund } = await createClosedShift({
      sourceBalance: '300',
      countedCash: '300',
    });
    const first = await service.create(requesterId, {
      shiftId: shift.id,
      destinationFundId: destinationFund.id,
      retainedCash: '100',
    });
    await service.reject(first.id, reviewerId, {
      reason: 'Retained float needs correction',
    });

    const corrected = await service.create(requesterId, {
      shiftId: shift.id,
      destinationFundId: destinationFund.id,
      retainedCash: '150',
    });

    expect(corrected.status).toBe(CashHandoverStatus.PENDING);
    expect(corrected.transferAmount.toString()).toBe('150');
  });

  it('settles a bank deposit once and rejects a duplicate bank reference', async () => {
    const { shift, sourceFund, destinationFund } = await createClosedShift({
      sourceBalance: '500',
      countedCash: '500',
      destinationType: FundType.BANK,
    });
    const pending = await service.create(requesterId, {
      shiftId: shift.id,
      destinationFundId: destinationFund.id,
      retainedCash: '100',
    });
    const approved = await service.approve(pending.id, reviewerId, {});

    expect(approved.settlementStatus).toBe(
      CashHandoverSettlementStatus.PENDING,
    );
    expect(approved.destinationTransactionId).toBeNull();
    const [sourceAfterApproval, destinationAfterApproval] = await Promise.all([
      prisma.fund.findUniqueOrThrow({ where: { id: sourceFund.id } }),
      prisma.fund.findUniqueOrThrow({ where: { id: destinationFund.id } }),
    ]);
    expect(sourceAfterApproval.balance.toString()).toBe('100');
    expect(destinationAfterApproval.balance.toString()).toBe('0');

    const settlementResults = await Promise.allSettled([
      service.settle(approved.id, reviewerId, {
        bankReference: 'bank-settlement-001',
        evidenceReference: 'receipts/bank-settlement-001.pdf',
      }),
      service.settle(approved.id, reviewerId, {
        bankReference: 'bank-settlement-001',
        evidenceReference: 'receipts/bank-settlement-001.pdf',
      }),
    ]);
    expect(
      settlementResults.filter(({ status }) => status === 'fulfilled'),
    ).toHaveLength(1);
    expect(
      settlementResults.filter(({ status }) => status === 'rejected'),
    ).toHaveLength(1);
    const destinationAfterSettlement = await prisma.fund.findUniqueOrThrow({
      where: { id: destinationFund.id },
    });
    expect(destinationAfterSettlement.balance.toString()).toBe('400');

    const second = await createClosedShift({
      sourceBalance: '600',
      countedCash: '600',
      destinationFundId: destinationFund.id,
    });
    const secondPending = await service.create(requesterId, {
      shiftId: second.shift.id,
      destinationFundId: destinationFund.id,
      retainedCash: '100',
    });
    const secondApproved = await service.approve(
      secondPending.id,
      reviewerId,
      {},
    );

    await expect(
      service.settle(secondApproved.id, reviewerId, {
        bankReference: 'BANK-SETTLEMENT-001',
        evidenceReference: 'receipts/duplicate.pdf',
      }),
    ).rejects.toBeInstanceOf(ConflictException);
    const destinationAfterDuplicate = await prisma.fund.findUniqueOrThrow({
      where: { id: destinationFund.id },
    });
    expect(destinationAfterDuplicate.balance.toString()).toBe('400');

    await prisma.cashHandover.update({
      where: { id: secondApproved.id },
      data: { settlementDueAt: new Date(Date.now() - 60_000) },
    });
    const overdue = await service.findOverdue({ itemPerPage: 20, page: 1 });
    expect(overdue.list.map(({ id }) => id)).toContain(secondApproved.id);
  });
});
