import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { ConflictException, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CashFlowType, FundType, ShiftStatus } from '@prisma/client';
import { CashierShiftLedgerService } from '../src/app/cashier-shifts/cashier-shift-ledger.service';
import { CashierShiftsService } from '../src/app/cashier-shifts/cashier-shifts.service';
import { FundsService } from '../src/app/cashier-shifts/funds.service';
import { DomainEventBusService } from '../src/app/durable/domain-event-bus.service';
import { IdempotencyService } from '../src/app/durable/idempotency.service';
import { OutboxDispatcherService } from '../src/app/durable/outbox-dispatcher.service';
import { transactionRetriesTotal } from '../src/common/observability/metrics';
import {
  PrismaService,
  type ExtendedPrismaClient,
} from '../src/common/prisma/prisma.service';
import { PaginationUtilService } from '../src/common/utils/pagination-util/pagination-util.service';

describe('Cashier command safety (PostgreSQL)', () => {
  let base: PrismaService;
  let prisma: ExtendedPrismaClient;
  let shifts: CashierShiftsService;
  let positionId: string;
  const employeeIds: string[] = [];
  const fundIds: string[] = [];

  beforeAll(async () => {
    assert(
      process.env.DATABASE_URL,
      'An explicit test DATABASE_URL is required.',
    );
    const url = new URL(process.env.DATABASE_URL);
    assert(
      process.env.NODE_ENV === 'test' &&
        ['postgres:', 'postgresql:'].includes(url.protocol) &&
        ['127.0.0.1', 'localhost'].includes(url.hostname) &&
        /^[^/]+_test$/.test(decodeURIComponent(url.pathname.slice(1))),
      'Only use a dedicated loopback *_test database.',
    );
    base = new PrismaService();
    await base.$connect();
    prisma = base.getExtendedClient();
    shifts = new CashierShiftsService(
      prisma,
      new PaginationUtilService(),
      new CashierShiftLedgerService(),
      new IdempotencyService(prisma),
    );
    positionId = (
      await base.position.create({
        data: { name: `Cashier safety ${randomUUID()}`, salary: 0 },
      })
    ).id;
  }, 30_000);

  afterEach(() => jest.restoreAllMocks());

  afterAll(async () => {
    if (!base) return;
    try {
      await base.idempotencyRequest.deleteMany({
        where: { employeeId: { in: employeeIds } },
      });
      await base.cashTransaction.deleteMany({
        where: { employeeId: { in: employeeIds } },
      });
      await base.$transaction(async (tx) => {
        await tx.$executeRaw`SET LOCAL app.allow_audit_log_mutation = 'on'`;
        await tx.actionLog.deleteMany({
          where: { employeeId: { in: employeeIds } },
        });
      });
      await base.cashierShift.deleteMany({
        where: { employeeId: { in: employeeIds } },
      });
      await base.fund.deleteMany({ where: { id: { in: fundIds } } });
      await base.employee.deleteMany({ where: { id: { in: employeeIds } } });
      if (positionId) await base.position.delete({ where: { id: positionId } });
    } finally {
      await base.$disconnect();
    }
  });

  async function fixture(balance = '1000') {
    const suffix = randomUUID();
    const employee = await base.employee.create({
      data: {
        username: suffix,
        email: `cashier-safety-${suffix}@example.test`,
        fullName: 'Cashier safety fixture',
        password: 'not-used-for-authentication',
        positionId,
      },
    });
    employeeIds.push(employee.id);
    const fund = await base.fund.create({
      data: { name: `Safety drawer ${suffix}`, type: FundType.CASH, balance },
    });
    fundIds.push(fund.id);
    return { employee, fund };
  }

  async function cleanupExpiredCommands() {
    const dispatcher = new OutboxDispatcherService(
      prisma,
      new ConfigService(),
      new DomainEventBusService(),
    );
    await dispatcher.drainOnce();
  }

  it('posts a concurrent cash command once and retains replay protection after housekeeping', async () => {
    const f = await fixture();
    const shift = await shifts.open(f.employee.id, {
      fundId: f.fund.id,
      startingCash: '1000',
      idempotencyKey: randomUUID(),
    });
    const dto = {
      expectedShiftId: shift.id,
      idempotencyKey: randomUUID(),
      type: CashFlowType.INCOME,
      amount: '100',
      description: 'Additional cash float',
    };
    const [first, second] = await Promise.all([
      shifts.addMovement(f.employee.id, dto),
      shifts.addMovement(f.employee.id, dto),
    ]);
    expect(first.movement?.id).toBe(second.movement?.id);
    await base.idempotencyRequest.updateMany({
      where: { employeeId: f.employee.id },
      data: { expiresAt: new Date(0) },
    });
    await cleanupExpiredCommands();
    const replay = await shifts.addMovement(f.employee.id, dto);
    expect(replay.movement?.id).toBe(first.movement?.id);
    await expect(
      shifts.addMovement(f.employee.id, { ...dto, amount: '200' }),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(
      await base.cashTransaction.count({ where: { shiftId: shift.id } }),
    ).toBe(1);
    expect(
      (
        await base.fund.findUniqueOrThrow({ where: { id: f.fund.id } })
      ).balance.toFixed(2),
    ).toBe('1100.00');
  });

  it('never closes or charges a replacement shift, even after the old replay expiry', async () => {
    const f = await fixture();
    const first = await shifts.open(f.employee.id, {
      fundId: f.fund.id,
      startingCash: '1000',
      idempotencyKey: randomUUID(),
    });
    const close = {
      expectedShiftId: first.id,
      reportedEndingCash: '1000',
      idempotencyKey: randomUUID(),
    };
    await shifts.close(f.employee.id, close);
    const next = await shifts.open(f.employee.id, {
      fundId: f.fund.id,
      startingCash: '1000',
      idempotencyKey: randomUUID(),
    });
    await base.idempotencyRequest.updateMany({
      where: { employeeId: f.employee.id },
      data: { expiresAt: new Date(0) },
    });
    await cleanupExpiredCommands();
    expect((await shifts.close(f.employee.id, close)).id).toBe(first.id);
    await expect(
      shifts.close(f.employee.id, { ...close, idempotencyKey: randomUUID() }),
    ).rejects.toBeInstanceOf(ConflictException);
    await expect(
      shifts.addMovement(f.employee.id, {
        expectedShiftId: first.id,
        type: CashFlowType.INCOME,
        amount: '100',
        description: 'Stale command',
        idempotencyKey: randomUUID(),
      }),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(
      (await base.cashierShift.findUniqueOrThrow({ where: { id: next.id } }))
        .status,
    ).toBe(ShiftStatus.OPEN);
    expect(
      await base.cashTransaction.count({
        where: { employeeId: f.employee.id },
      }),
    ).toBe(0);
  });

  it.each(['remove', 'change-type'])(
    'serializes fund %s against a concurrent shift open',
    async (operation) => {
      const f = await fixture('0');
      let reached!: () => void;
      let release!: () => void;
      const atUpdate = new Promise<void>((resolve) => {
        reached = resolve;
      });
      const resume = new Promise<void>((resolve) => {
        release = resolve;
      });
      let paused = false;
      // Pause the real update after its checks so the new shift commits first.
      const controlled = base.$extends({
        query: {
          fund: {
            async update({ args, query }) {
              if (!paused && args.where.id === f.fund.id) {
                paused = true;
                reached();
                await resume;
              }
              return query(args);
            },
          },
        },
      });
      const funds = new FundsService(controlled, new PaginationUtilService());
      const retry = jest.spyOn(transactionRetriesTotal, 'inc');
      jest.spyOn(Logger, 'warn').mockImplementation();
      const editing = (
        operation === 'remove'
          ? funds.remove(f.fund.id, f.employee.id)
          : funds.update(f.fund.id, f.employee.id, { type: FundType.BANK })
      ).catch((error: unknown) => error);
      try {
        await Promise.race([
          atUpdate,
          sleep(3000, undefined, { ref: false }).then(() => {
            throw new Error('Fund update did not reach barrier.');
          }),
        ]);
        const shift = await shifts.open(f.employee.id, {
          fundId: f.fund.id,
          startingCash: '0',
          idempotencyKey: randomUUID(),
        });
        release();
        expect(await editing).toBeInstanceOf(ConflictException);
        const fund = await base.fund.findUniqueOrThrow({
          where: { id: f.fund.id },
        });
        expect(fund.type).toBe(FundType.CASH);
        expect(fund.deletedAt).toBeNull();
        expect(
          (
            await base.cashierShift.findUniqueOrThrow({
              where: { id: shift.id },
            })
          ).status,
        ).toBe(ShiftStatus.OPEN);
        expect(retry).toHaveBeenCalledWith({
          context: 'Transaction',
          error_code: 'P2034',
        });
      } finally {
        release();
        await editing;
      }
    },
  );
});
