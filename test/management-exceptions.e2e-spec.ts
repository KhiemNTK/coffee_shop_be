import { PrismaClient } from '@prisma/client';
import { ManagementExceptionsService } from '../src/app/management-exceptions/management-exceptions.service';
import type { ExtendedPrismaClient } from '../src/common/prisma/prisma.service';
import { PaginationUtilService } from '../src/common/utils/pagination-util/pagination-util.service';

describe('Management exception inbox (e2e)', () => {
  const prisma = new PrismaClient();
  const service = new ManagementExceptionsService(
    prisma as unknown as ExtendedPrismaClient,
    new PaginationUtilService(),
  );

  afterAll(() => prisma.$disconnect());

  it('reads live PostgreSQL source tables without mutating them', async () => {
    const [summary, payment, cashExpense, cashHandover, feedback] =
      await Promise.all([
        service.summary(),
        service.findAll({ kind: 'PAYMENT', page: 1, itemPerPage: 10 }),
        service.findAll({ kind: 'CASH_EXPENSE', page: 1, itemPerPage: 10 }),
        service.findAll({ kind: 'CASH_HANDOVER', page: 1, itemPerPage: 10 }),
        service.findAll({ kind: 'FEEDBACK', page: 1, itemPerPage: 10 }),
      ]);

    expect(summary.total).toBe(
      Object.values(summary.counts).reduce((sum, count) => sum + count, 0),
    );
    expect(payment.list.length).toBeLessThanOrEqual(10);
    expect(cashExpense.list.length).toBeLessThanOrEqual(10);
    expect(cashHandover.list.length).toBeLessThanOrEqual(10);
    expect(feedback.list.length).toBeLessThanOrEqual(10);
    for (const page of [payment, cashExpense, cashHandover, feedback]) {
      expect(page.list.every((item) => Boolean(item.id))).toBe(true);
    }
  });
});
