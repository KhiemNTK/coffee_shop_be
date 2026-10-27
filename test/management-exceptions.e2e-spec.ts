import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { CashHandoverStatus, PrismaClient, ServeStatus } from '@prisma/client';
import { ManagementExceptionsService } from '../src/app/management-exceptions/management-exceptions.service';
import type { ExtendedPrismaClient } from '../src/common/prisma/prisma.service';
import { PaginationUtilService } from '../src/common/utils/pagination-util/pagination-util.service';
import { IdempotencyService } from '../src/app/durable/idempotency.service';
import { ConfigService } from '@nestjs/config';
import { Logger } from '@nestjs/common';
import { DomainEventBusService } from '../src/app/durable/domain-event-bus.service';
import { OutboxDispatcherService } from '../src/app/durable/outbox-dispatcher.service';
import { OutboxPermanentError } from '../src/app/durable/outbox-delivery.error';

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

  it('persists safe failure metadata and exposes the original request ID after real dispatch', async () => {
    const rollback = new Error('Rollback dispatch fixture');
    const log = jest.spyOn(Logger.prototype, 'error').mockImplementation();
    try {
      await expect(
        prisma.$transaction(
          async (tx) => {
            const event = await tx.outboxEvent.create({
              data: {
                topic: 'order',
                eventName: 'management.test',
                aggregateType: 'Test',
                aggregateId: randomUUID(),
                payload: { token: 'private-payload' },
                context: { requestId: 'original-dispatch-request' },
                availableAt: new Date(Date.now() - 1_000),
              },
            });
            const bus = new DomainEventBusService();
            bus.on(event.eventName, () => {
              throw new OutboxPermanentError(
                'Authorization: Bearer private-credential',
              );
            });
            const dispatcher = new OutboxDispatcherService(
              tx as unknown as ExtendedPrismaClient,
              new ConfigService(),
              bus,
            );
            await dispatcher.drainOnce();
            const failed = await tx.outboxEvent.findUniqueOrThrow({
              where: { id: event.id },
            });
            expect(failed).toMatchObject({
              status: 'DEAD_LETTER',
              lastErrorCode: 'PERMANENT_REJECTION',
              lastError: 'Authorization: [REDACTED]',
              attempts: 1,
            });
            expect(failed.lastFailedAt).toBeInstanceOf(Date);
            expect(failed.payload).toEqual(event.payload);
            const inbox = new ManagementExceptionsService(
              tx as unknown as ExtendedPrismaClient,
              new PaginationUtilService(),
              {} as never,
            );
            const result = await inbox.findAll({
              kind: 'OUTBOX_DEAD_LETTER',
              page: 1,
              itemPerPage: 10,
            });
            expect(result.list).toEqual([
              expect.objectContaining({
                id: event.id,
                requestId: 'original-dispatch-request',
                lastErrorCode: 'PERMANENT_REJECTION',
              }),
            ]);
            expect(JSON.stringify(result)).not.toMatch(
              /private-|lastError"|context/,
            );
            throw rollback;
          },
          { timeout: 15_000 },
        ),
      ).rejects.toBe(rollback);
    } finally {
      log.mockRestore();
    }
  });

  it('reads live PostgreSQL source tables without mutating them', async () => {
    const [
      summary,
      payment,
      cashExpense,
      cashHandover,
      feedback,
      kitchen,
      pickup,
      print,
      outbox,
    ] = await Promise.all([
      service.summary(),
      service.findAll({ kind: 'PAYMENT', page: 1, itemPerPage: 10 }),
      service.findAll({ kind: 'CASH_EXPENSE', page: 1, itemPerPage: 10 }),
      service.findAll({ kind: 'CASH_HANDOVER', page: 1, itemPerPage: 10 }),
      service.findAll({ kind: 'FEEDBACK', page: 1, itemPerPage: 10 }),
      service.findAll({ kind: 'KITCHEN_OVERDUE', page: 1, itemPerPage: 10 }),
      service.findAll({ kind: 'ONLINE_PICKUP_LATE', page: 1, itemPerPage: 10 }),
      service.findAll({ kind: 'PRINT_REVIEW', page: 1, itemPerPage: 10 }),
      service.findAll({ kind: 'OUTBOX_DEAD_LETTER', page: 1, itemPerPage: 10 }),
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
      print,
      outbox,
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
          const fixture = async (serveStatus: ServeStatus, readyAt?: Date) =>
            tx.orderSession.create({
              data: {
                employeeId: employee.id,
                orderItems: {
                  create: {
                    menuItemId: menu.id,
                    quantity: 1,
                    priceAtTime: 100,
                    serveStatus,
                    readyAt,
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
          for (const [status, pickupAt, readyAt] of [
            [ServeStatus.READY, past, past],
            [ServeStatus.SERVED, past, past],
            [ServeStatus.CANCELLED, past, past],
            [ServeStatus.READY, future, past],
            [ServeStatus.READY, null, now],
            [ServeStatus.COOKING, null, past],
            [ServeStatus.READY, null, null],
          ] as const) {
            const session = await fixture(status, readyAt ?? undefined);
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
          const asap = await fixture(ServeStatus.READY, past);
          await tx.onlineOrderRequest.create({
            data: {
              clientRequestId: randomUUID(),
              requestHash: 'a'.repeat(64),
              pickupName: 'ASAP customer',
              phoneNumber: '0900000000',
              quotedSubtotal: 100,
              expiresAt: future,
              status: 'ACCEPTED',
              orderSessionId: asap.id,
              reviewedAt: now,
              reviewedById: employee.id,
            },
          });
          const printer = await tx.printDevice.create({
            data: {
              name: suffix,
              type: 'RECEIPT',
              paperSize: '80mm',
              apiKeyHash: 'f'.repeat(64),
            },
          });
          const printReview = await tx.printJob.create({
            data: {
              type: 'PRECHECK',
              orderSessionId: asap.id,
              deviceId: printer.id,
              status: 'REQUIRES_REVIEW',
              payload: { token: 'private-fixture' },
            },
          });
          const printed = await tx.printJob.create({
            data: {
              type: 'PRECHECK',
              orderSessionId: asap.id,
              deviceId: printer.id,
              printedAt: now,
              status: 'PRINTED',
              payload: {},
            },
          });
          const event = await tx.outboxEvent.create({
            data: {
              topic: 'order',
              eventName: 'order.test',
              aggregateType: 'Invoice',
              aggregateId: suffix,
              payload: { token: 'private-fixture' },
              status: 'DEAD_LETTER',
              attempts: 5,
              lastError: 'private-fixture',
              lastErrorCode: 'PERMANENT_REJECTION',
              lastFailedAt: now,
              context: {
                requestId: 'original-request-fixture',
                employeeId: employee.id,
              },
            },
          });
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
          expect(pickup.list).toEqual(
            expect.arrayContaining([
              expect.objectContaining({ orderSessionId: asap.id }),
            ]),
          );
          const prints = await inbox.findAll({
            kind: 'PRINT_REVIEW',
            page: 1,
            itemPerPage: 50,
          });
          expect(prints.list).toEqual(
            expect.arrayContaining([
              expect.objectContaining({ id: printReview.id }),
            ]),
          );
          expect(prints.list).not.toEqual(
            expect.arrayContaining([
              expect.objectContaining({ id: printed.id }),
            ]),
          );
          const events = await inbox.findAll({
            kind: 'OUTBOX_DEAD_LETTER',
            page: 1,
            itemPerPage: 50,
          });
          expect(events.list).toEqual(
            expect.arrayContaining([
              expect.objectContaining({
                id: event.id,
                lastErrorCode: 'PERMANENT_REJECTION',
                lastFailedAt: now,
                requestId: 'original-request-fixture',
              }),
            ]),
          );
          expect(JSON.stringify([prints, events])).not.toContain(
            'private-fixture',
          );
          expect(JSON.stringify(events.list)).not.toContain('context');
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
          expect(caseSummary.counts.ONLINE_PICKUP_LATE).toBe(2);
          expect(caseSummary.counts.PRINT_REVIEW).toBe(1);
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
