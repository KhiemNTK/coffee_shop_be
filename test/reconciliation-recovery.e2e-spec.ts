import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { ConflictException } from '@nestjs/common';
import { BankStatementEntryDirection, PrismaClient } from '@prisma/client';
import { BankReconciliationService } from '../src/app/cashier-shifts/bank-reconciliation.service';
import { PaymentReconciliationService } from '../src/app/payments/payment-reconciliation.service';
import { GetPaymentIncidentsDto } from '../src/app/payments/dto';
import { PaginationUtilService } from '../src/common/utils/pagination-util/pagination-util.service';

describe('Reconciliation recovery (isolated PostgreSQL)', () => {
  const databaseName = `reconciliation_${randomUUID().replaceAll('-', '')}_test`;
  const employeeId = randomUUID();
  const fundId = randomUUID();
  let admin: PrismaClient | undefined;
  let prisma: PrismaClient | undefined;
  let created = false;
  let service: BankReconciliationService;
  const statement = {
    fundId,
    sourceFileName: 'statement.json',
    statementFrom: new Date('2026-10-01T00:00:00Z'),
    statementTo: new Date('2026-10-02T00:00:00Z'),
    entries: [
      {
        externalId: 'BANK-001',
        direction: BankStatementEntryDirection.CREDIT,
        amount: '80000',
        transactionDate: new Date('2026-10-01T12:00:00Z'),
      },
    ],
  };

  beforeAll(async () => {
    const url = new URL(process.env.DATABASE_URL ?? '');
    assert(
      process.env.NODE_ENV === 'test' &&
        ['localhost', '127.0.0.1'].includes(url.hostname) &&
        url.pathname.endsWith('_test'),
      'Only use a dedicated loopback test database.',
    );
    const adminUrl = new URL(url);
    adminUrl.pathname = '/postgres';
    admin = new PrismaClient({ datasources: { db: { url: adminUrl.href } } });
    await admin.$executeRawUnsafe(`CREATE DATABASE "${databaseName}"`);
    created = true;
    url.pathname = `/${databaseName}`;
    execFileSync(
      process.execPath,
      [require.resolve('prisma/build/index.js'), 'migrate', 'deploy'],
      { env: { ...process.env, DATABASE_URL: url.href }, stdio: 'pipe' },
    );
    prisma = new PrismaClient({ datasources: { db: { url: url.href } } });
    const position = await prisma.position.create({
      data: { name: 'Recovery test', salary: 0 },
    });
    await prisma.employee.create({
      data: {
        id: employeeId,
        positionId: position.id,
        fullName: 'Recovery test',
        email: 'recovery@example.test',
        username: 'recovery-test',
        password: 'unused',
      },
    });
    await prisma.fund.create({
      data: { id: fundId, name: 'Recovery bank', type: 'BANK' },
    });
    service = new BankReconciliationService(
      prisma as never,
      new PaginationUtilService(),
      {} as never,
    );
  }, 120_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    if (created)
      await admin?.$executeRawUnsafe(
        `DROP DATABASE "${databaseName}" WITH (FORCE)`,
      );
    await admin?.$disconnect();
  });

  it('commits one import, one entry and one import audit for concurrent identical requests', async () => {
    const results = await Promise.all([
      service.createImport(employeeId, statement),
      service.createImport(employeeId, statement),
    ]);
    expect(results[0].statementImport.id).toBe(results[1].statementImport.id);
    expect(await prisma!.bankStatementImport.count()).toBe(1);
    expect(await prisma!.bankStatementEntry.count()).toBe(1);
    expect(
      await prisma!.actionLog.count({
        where: { actionType: 'BANK_STATEMENT_IMPORTED' },
      }),
    ).toBe(1);
    expect(
      (
        await prisma!.fund.findUniqueOrThrow({ where: { id: fundId } })
      ).balance.toFixed(2),
    ).toBe('0.00');
  });

  it('recovers a lost reply without mutations and rejects overlaps with changed amounts', async () => {
    const auditCount = await prisma!.actionLog.count();
    const result = await service.recoverImport(employeeId, {
      ...statement,
      sourceFileName: 'renamed.json',
    });
    expect(result.replayed).toBe(true);
    expect(await prisma!.actionLog.count()).toBe(auditCount);
    await expect(
      service.createImport(employeeId, {
        ...statement,
        entries: [{ ...statement.entries[0], amount: '81000' }],
      }),
    ).rejects.toThrow(ConflictException);
    expect(await prisma!.bankStatementImport.count()).toBe(1);
  });

  it('executes bounded incident searches, including UUID and enum terms, on PostgreSQL', async () => {
    const payments = new PaymentReconciliationService(
      prisma as never,
      new PaginationUtilService(),
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );
    for (const keyword of ['INV-2026', 'stale', randomUUID()]) {
      expect(
        await payments.findIncidents(
          GetPaymentIncidentsDto.schema.parse({
            keyword,
            status: 'OPEN',
            page: 2,
          }),
        ),
      ).toMatchObject({ list: [], totalItems: 0 });
    }
  });
});
