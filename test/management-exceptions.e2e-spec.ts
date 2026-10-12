import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { CashHandoverStatus, PrismaClient, ServeStatus } from '@prisma/client';
import { ManagementExceptionsService } from '../src/app/management-exceptions/management-exceptions.service';
import type { ExtendedPrismaClient } from '../src/common/prisma/prisma.service';
import { PaginationUtilService } from '../src/common/utils/pagination-util/pagination-util.service';
import { IdempotencyService } from '../src/app/durable/idempotency.service';

describe('Management exception inbox (e2e)', () => {
  const prisma = new PrismaClient();
  const service = new ManagementExceptionsService(
    prisma as unknown as ExtendedPrismaClient,
    new PaginationUtilService(),
    new IdempotencyService(prisma as unknown as ExtendedPrismaClient),
  );

  beforeAll(async () => {
    const target = new URL(process.env.DATABASE_URL ?? '');
    assert(
      process.env.NODE_ENV === 'test' &&
        ['127.0.0.1', 'localhost'].includes(target.hostname) &&
        target.pathname.endsWith('_test'),
      'Only use a dedicated loopback test database.',
    );
    await prisma.$connect();
  });

  afterAll(() => prisma.$disconnect());

  it('reads live PostgreSQL source tables without mutating them', async () => {
    const [
      summary,
      payment,
      cashExpense,
      cashHandover,
      feedback,
      kitchen,
      pickup,
    ] = await Promise.all([
      service.summary(),
      service.findAll({ kind: 'PAYMENT', page: 1, itemPerPage: 10 }),
      service.findAll({ kind: 'CASH_EXPENSE', page: 1, itemPerPage: 10 }),
      service.findAll({ kind: 'CASH_HANDOVER', page: 1, itemPerPage: 10 }),
      service.findAll({ kind: 'FEEDBACK', page: 1, itemPerPage: 10 }),
      service.findAll({ kind: 'KITCHEN_OVERDUE', page: 1, itemPerPage: 10 }),
      service.findAll({ kind: 'ONLINE_PICKUP_LATE', page: 1, itemPerPage: 10 }),
    ]);

    expect(summary.total).toBe(
      Object.values(summary.counts).reduce((sum, count) => sum + count, 0),
    );
    expect(payment.list.length).toBeLessThanOrEqual(10);
    expect(cashExpense.list.length).toBeLessThanOrEqual(10);
    expect(cashHandover.list.length).toBeLessThanOrEqual(10);
    expect(feedback.list.length).toBeLessThanOrEqual(10);
    for (const page of [
      payment,
      cashExpense,
      cashHandover,
      feedback,
      kitchen,
      pickup,
    ]) {
      expect(page.list.length).toBeLessThanOrEqual(10);
      expect(page.list.every((item) => Boolean(item.id))).toBe(true);
    }
  });

  it('excludes completed/scheduled tickets, collected orders and rejected handovers in real SQL', async () => {
    const rollback = new Error('Rollback test fixtures');
    await expect(
      prisma.$transaction(
        async (tx) => {
          const suffix = randomUUID();
          const now = new Date();
          const past = new Date(now.getTime() - 30 * 60 * 1000);
          const future = new Date(now.getTime() + 30 * 60 * 1000);
          const employee = await tx.employee.create({
            data: {
              email: `${suffix}@operations-test.example`,
              username: suffix,
              fullName: 'Operations test',
              password: 'test-only',
              position: { create: { name: suffix, salary: 0 } },
            },
          });
          const menu = await tx.menuItem.create({
            data: {
              name: suffix,
              price: 100,
              category: { create: { name: suffix } },
            },
          });
          const station = await tx.kitchenStation.create({
            data: { code: suffix, name: suffix },
          });
          const fixture = async (serveStatus: ServeStatus) =>
            tx.orderSession.create({
              data: {
                employeeId: employee.id,
                orderItems: {
                  create: {
                    menuItemId: menu.id,
                    quantity: 1,
                    priceAtTime: 100,
                    serveStatus,
                  },
                },
              },
              include: { orderItems: true },
            });
          const tickets: string[] = [];
          for (const [status, availableAt] of [
            [ServeStatus.PENDING, null],
            [ServeStatus.READY, null],
            [ServeStatus.CANCELLED, null],
            [ServeStatus.COOKING, future],
          ] as const) {
            const session = await fixture(status);
            const ticket = await tx.kitchenTicket.create({
              data: {
                dueAt: past,
                createdAt: past,
                availableAt,
                stationId: station.id,
                orderSessionId: session.id,
                items: {
                  create: {
                    orderItemId: session.orderItems[0].id,
                    itemName: menu.name,
                    quantity: 1,
                  },
                },
              },
            });
            tickets.push(ticket.id);
          }
          const requests: string[] = [];
          for (const [status, pickupAt] of [
            [ServeStatus.READY, past],
            [ServeStatus.SERVED, past],
            [ServeStatus.CANCELLED, past],
            [ServeStatus.READY, future],
          ] as const) {
            const session = await fixture(status);
            const request = await tx.onlineOrderRequest.create({
              data: {
                clientRequestId: randomUUID(),
                requestHash: 'a'.repeat(64),
                pickupName: 'Test customer',
                phoneNumber: '0900000000',
                quotedSubtotal: 100,
                createdAt: new Date(past.getTime() - 60_000),
                pickupAt,
                expiresAt: future,
                status: 'ACCEPTED',
                reviewedAt: now,
                reviewedById: employee.id,
                orderSessionId: session.id,
              },
            });
            requests.push(request.id);
          }
          const source = await tx.fund.create({
            data: { name: suffix, type: 'CASH', balance: 0 },
          });
          const destination = await tx.fund.create({
            data: { name: `${suffix}-bank`, type: 'BANK', balance: 0 },
          });
          const shift = await tx.cashierShift.create({
            data: {
              employeeId: employee.id,
              fundId: source.id,
              startingCash: 0,
              expectedStartingCash: 0,
              openedAt: past,
              reportedEndingCash: 100,
              actualEndingCash: 100,
              status: 'CLOSED',
              closedAt: now,
            },
          });
          const handovers: string[] = [];
          const sourceTransaction = await tx.cashTransaction.create({
            data: {
              type: 'EXPENSE',
              amount: 100,
              description: 'Test cash handover',
              transactionDate: now,
              fundId: source.id,
              employeeId: employee.id,
              shiftId: shift.id,
            },
          });
          for (const status of [
            CashHandoverStatus.APPROVED,
            CashHandoverStatus.REJECTED,
            CashHandoverStatus.CANCELLED,
          ]) {
            const handover = await tx.cashHandover.create({
              data: {
                expectedCash: 100,
                countedCash: 100,
                varianceAmount: 0,
                retainedCash: 0,
                transferAmount: 100,
                status,
                settlementStatus:
                  status === 'APPROVED' ? 'PENDING' : 'NOT_REQUIRED',
                settlementDueAt: status === 'APPROVED' ? future : null,
                sourceTransactionId:
                  status === 'APPROVED' ? sourceTransaction.id : null,
                resolvedAt: now,
                resolvedById: employee.id,
                resolutionNote: 'Test resolution',
                requestedById: employee.id,
                shiftId: shift.id,
                sourceFundId: source.id,
                destinationFundId: destination.id,
              },
            });
            handovers.push(handover.id);
          }
          const inbox = new ManagementExceptionsService(
            tx as unknown as ExtendedPrismaClient,
            new PaginationUtilService(),
            new IdempotencyService(prisma as unknown as ExtendedPrismaClient),
          );
          const kitchen = await inbox.findAll({
            kind: 'KITCHEN_OVERDUE',
            page: 1,
            itemPerPage: 50,
          });
          const pickup = await inbox.findAll({
            kind: 'ONLINE_PICKUP_LATE',
            page: 1,
            itemPerPage: 50,
          });
          const cash = await inbox.findAll({
            kind: 'CASH_HANDOVER',
            page: 1,
            itemPerPage: 50,
          });
          for (const [page, ids] of [
            [kitchen, tickets],
            [pickup, requests],
            [cash, handovers],
          ] as const) {
            expect(page?.list).toEqual(
              expect.arrayContaining([expect.objectContaining({ id: ids[0] })]),
            );
            for (const id of ids.slice(1)) {
              expect(page?.list).not.toEqual(
                expect.arrayContaining([expect.objectContaining({ id })]),
              );
            }
          }
          const caseSummary = await inbox.summary();
          expect(caseSummary.total).toBe(
            Object.values(caseSummary.counts).reduce(
              (sum, count) => sum + count,
              0,
            ),
          );
          throw rollback;
        },
        { timeout: 15_000 },
      ),
    ).rejects.toBe(rollback);
  });
});
