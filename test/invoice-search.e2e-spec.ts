import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import {
  PrismaService,
  type ExtendedPrismaClient,
} from '../src/common/prisma/prisma.service';
import { InvoicesService } from '../src/app/invoices/invoices.service';
import { GetInvoicesPaginationDto } from '../src/app/invoices/dto';
import { PaginationUtilService } from '../src/common/utils/pagination-util/pagination-util.service';
import { QueryUtilService } from '../src/common/utils/query-util/query-util.service';

describe('Invoice lookup (isolated PostgreSQL)', () => {
  const originalUrl = process.env.DATABASE_URL;
  const databaseName = `invoice_lookup_${randomUUID().replaceAll('-', '')}_test`;
  let created = false;
  let admin: PrismaClient;
  let base: PrismaService;
  let db: ExtendedPrismaClient;
  let service: InvoicesService;
  let employeeId: string;
  let sessionId: string;
  let shiftId: string;

  beforeAll(async () => {
    const target = new URL(process.env.DATABASE_URL ?? '');
    assert(
      process.env.NODE_ENV === 'test' &&
        ['localhost', '127.0.0.1'].includes(target.hostname) &&
        target.pathname.endsWith('_test'),
      'Dedicated loopback test configuration required.',
    );
    const adminUrl = new URL(target);
    adminUrl.pathname = '/postgres';
    admin = new PrismaClient({ datasources: { db: { url: adminUrl.href } } });
    await admin.$executeRawUnsafe(`CREATE DATABASE "${databaseName}"`);
    created = true;
    target.pathname = `/${databaseName}`;
    process.env.DATABASE_URL = target.href;
    execFileSync(
      process.execPath,
      [require.resolve('prisma/build/index.js'), 'migrate', 'deploy'],
      { env: process.env, stdio: 'pipe' },
    );
    base = new PrismaService();
    db = base.getExtendedClient();
    service = new InvoicesService(
      db,
      new PaginationUtilService(),
      new QueryUtilService(),
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );
    const position = await db.position.create({
      data: { name: 'Lookup operator', salary: 0 },
    });
    const actor = await db.employee.create({
      data: {
        email: 'lookup@example.test',
        username: 'lookup',
        fullName: 'Current cashier',
        password: 'not-a-login',
        positionId: position.id,
      },
    });
    employeeId = actor.id;
    const shift = await db.cashierShift.create({ data: { employeeId } });
    shiftId = shift.id;
    const table = await db.diningTable.create({
      data: { name: 'Current terrace' },
    });
    const session = await db.orderSession.create({
      data: { employeeId, tableId: table.id, shiftId },
    });
    sessionId = session.id;
    const shared = {
      employeeId,
      orderSessionId: sessionId,
      subTotal: '35000',
      totalAmount: '35000',
    };
    await db.invoice.create({
      data: {
        ...shared,
        invoiceNumber: 'GLOBAL-OLD',
        createdAt: new Date('2026-09-01T00:00:00Z'),
      },
    });
    await db.invoice.create({
      data: {
        ...shared,
        invoiceNumber: 'GLOBAL-NEW',
        shiftId,
        createdAt: new Date('2026-10-02T01:00:00Z'),
      },
    });
    await db.invoice.create({
      data: {
        ...shared,
        invoiceNumber: 'SNAPSHOT-001',
        documentSnapshot: {
          version: 1,
          source: 'ISSUED',
          tableId: table.id,
          tableName: 'Old garden',
          issuedByName: 'Previous cashier',
          promotionName: null,
          items: [],
        },
      },
    });
  }, 120_000);

  afterAll(async () => {
    await base?.$disconnect();
    process.env.DATABASE_URL = originalUrl;
    if (created)
      await admin.$executeRawUnsafe(
        `DROP DATABASE "${databaseName}" WITH (FORCE)`,
      );
    await admin?.$disconnect();
  });

  const lookup = (query: unknown) =>
    service.getInvoices(GetInvoicesPaginationDto.schema.parse(query));

  it('searches beyond the current page with server totals and deterministic pagination', async () => {
    const first = await lookup({ keyword: 'global', page: 1, itemPerPage: 1 });
    const second = await lookup({ keyword: 'global', page: 2, itemPerPage: 1 });
    expect(first.totalItems).toBe(2);
    expect(first.totalPages).toBe(2);
    expect(first.list.map((row) => row.invoiceNumber)).toEqual(['GLOBAL-NEW']);
    expect(second.list.map((row) => row.invoiceNumber)).toEqual(['GLOBAL-OLD']);
  });
  it('searches immutable table/cashier names and uses live relations only for legacy invoices', async () => {
    expect(
      (await lookup({ keyword: 'OLD GARDEN' })).list.map(
        (row) => row.invoiceNumber,
      ),
    ).toEqual(['SNAPSHOT-001']);
    expect(
      (await lookup({ keyword: 'previous CASHIER' })).list.map(
        (row) => row.invoiceNumber,
      ),
    ).toEqual(['SNAPSHOT-001']);
    const current = await lookup({ keyword: 'Current terrace' });
    expect(current.totalItems).toBe(2);
    expect(
      current.list.some((row) => row.invoiceNumber === 'SNAPSHOT-001'),
    ).toBe(false);
  });
  it('combines global search with UTC day/shift filters without broadening the result', async () => {
    const result = await lookup({
      keyword: 'global',
      shiftId,
      createdFrom: '2026-10-01T17:00:00.000Z',
      createdTo: '2026-10-02T16:59:59.999Z',
    });
    expect(result.totalItems).toBe(1);
    expect(result.list[0]?.invoiceNumber).toBe('GLOBAL-NEW');
  });
});
