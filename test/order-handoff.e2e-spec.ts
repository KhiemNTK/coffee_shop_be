import { randomUUID } from 'node:crypto';
import { ConflictException, INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { NestExpressApplication } from '@nestjs/platform-express';
import { ServeStatus, SessionStatus } from '@prisma/client';
import { AppModule } from '../src/app/app.module';
import { OrdersService } from '../src/app/orders/orders.service';
import { KitchenService } from '../src/app/kitchen/kitchen.service';
import { DailySalesCloseService } from '../src/app/reports/daily-sales-close.service';
import { PrismaService } from '../src/common/prisma/prisma.service';
import { initApp } from '../src/init';
import request from 'supertest';
import { App } from 'supertest/types';

describe('Paid order handoff (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let orders: OrdersService;
  let kitchen: KitchenService;
  let dailyClose: DailySalesCloseService;
  let prefix: string;
  const ids: Record<string, string> = {};
  const suffix = randomUUID();
  let ticketSequence: number;

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    const expressApp = module.createNestApplication<NestExpressApplication>();
    initApp(expressApp);
    app = expressApp;
    prisma = module.get(PrismaService);
    orders = module.get(OrdersService);
    kitchen = module.get(KitchenService);
    dailyClose = module.get(DailySalesCloseService);
    prefix = module.get(ConfigService).get<string>('APP_PREFIX', '/api/v1');
    await app.init();

    const position = await prisma.position.create({
      data: { name: `Handoff position ${suffix}`, salary: 0 },
    });
    ids.position = position.id;
    const employee = await prisma.employee.create({
      data: {
        email: `handoff-${suffix}@example.com`,
        username: `handoff-${suffix}`,
        fullName: 'Handoff employee',
        password: 'test-only',
        positionId: position.id,
      },
    });
    ids.employee = employee.id;
    const category = await prisma.menuCategory.create({
      data: { name: `Handoff category ${suffix}` },
    });
    ids.category = category.id;
    const menuItem = await prisma.menuItem.create({
      data: {
        name: `Handoff latte ${suffix}`,
        price: 30_000,
        categoryId: category.id,
      },
    });
    ids.menuItem = menuItem.id;
    const session = await prisma.orderSession.create({
      data: { employeeId: employee.id, sessionStatus: SessionStatus.COMPLETED },
    });
    ids.session = session.id;
    const invoice = await prisma.invoice.create({
      data: {
        invoiceNumber: `HANDOFF-${suffix}`,
        subTotal: 30_000,
        totalAmount: 30_000,
        paymentStatus: 'PAID',
        orderSessionId: session.id,
        employeeId: employee.id,
      },
    });
    ids.invoice = invoice.id;
    const orderItem = await prisma.orderItem.create({
      data: {
        orderSessionId: session.id,
        menuItemId: menuItem.id,
        quantity: 1,
        priceAtTime: 30_000,
        invoiceId: invoice.id,
        isPaid: true,
      },
    });
    ids.orderItem = orderItem.id;
    const station = await prisma.kitchenStation.create({
      data: { code: `H-${suffix}`, name: `Handoff station ${suffix}` },
    });
    ids.station = station.id;
    const ticket = await prisma.kitchenTicket.create({
      data: {
        stationId: station.id,
        orderSessionId: session.id,
        dueAt: new Date(Date.now() + 5 * 60_000),
        items: {
          create: {
            orderItemId: orderItem.id,
            itemName: menuItem.name,
            quantity: 1,
          },
        },
      },
    });
    ids.ticket = ticket.id;
    ticketSequence = ticket.sequence;
  });

  afterAll(async () => {
    try {
      if (ids.orderItem) {
        await prisma.outboxEvent.deleteMany({
          where: { aggregateId: ids.orderItem },
        });
        await prisma.kitchenTicketItem.deleteMany({
          where: { orderItemId: ids.orderItem },
        });
      }
      if (ids.ticket)
        await prisma.kitchenTicket.deleteMany({ where: { id: ids.ticket } });
      if (ids.orderItem)
        await prisma.orderItem.deleteMany({ where: { id: ids.orderItem } });
      if (ids.invoice)
        await prisma.takeawayFeedback.deleteMany({
          where: { invoiceId: ids.invoice },
        });
      if (ids.invoice)
        await prisma.invoice.deleteMany({ where: { id: ids.invoice } });
      if (ids.session)
        await prisma.orderSession.deleteMany({ where: { id: ids.session } });
      if (ids.station)
        await prisma.kitchenStation.deleteMany({ where: { id: ids.station } });
      if (ids.menuItem)
        await prisma.menuItem.deleteMany({ where: { id: ids.menuItem } });
      if (ids.category)
        await prisma.menuCategory.deleteMany({ where: { id: ids.category } });
      if (ids.employee) {
        await prisma.$transaction(async (tx) => {
          await tx.$executeRawUnsafe(
            "SET LOCAL app.allow_audit_log_mutation = 'on'",
          );
          await tx.actionLog.deleteMany({
            where: { employeeId: ids.employee },
          });
        });
        await prisma.employee.deleteMany({ where: { id: ids.employee } });
      }
      if (ids.position)
        await prisma.position.deleteMany({ where: { id: ids.position } });
    } finally {
      await app?.close();
    }
  });

  it('hands off a paid takeaway order without reopening its session', async () => {
    await orders.updateItemStatus(ids.orderItem, ids.employee, {
      serveStatus: ServeStatus.COOKING,
    });
    const attempts = await Promise.allSettled([
      orders.updateItemStatus(ids.orderItem, ids.employee, {
        serveStatus: ServeStatus.READY,
      }),
      orders.updateItemStatus(ids.orderItem, ids.employee, {
        serveStatus: ServeStatus.READY,
      }),
    ]);
    expect(attempts.some((attempt) => attempt.status === 'fulfilled')).toBe(
      true,
    );
    const ready = await prisma.orderItem.findUniqueOrThrow({
      where: { id: ids.orderItem },
    });
    expect(ready.readyAt).toBeInstanceOf(Date);
    expect(
      await prisma.actionLog.count({
        where: {
          employeeId: ids.employee,
          actionType: 'ORDER_ITEM_STATUS_UPDATED',
        },
      }),
    ).toBe(2);
    const repeated = await orders.updateItemStatus(
      ids.orderItem,
      ids.employee,
      {
        serveStatus: ServeStatus.READY,
      },
    );
    expect(repeated.readyAt).toEqual(ready.readyAt);

    const handoff = await orders.getHandoffItems({ page: 1, itemPerPage: 20 });
    expect(handoff.list).toContainEqual(
      expect.objectContaining({
        id: ids.orderItem,
        ticketNumber: `H-${suffix}-${ticketSequence}`,
        readyAt: ready.readyAt,
      }),
    );
    await expect(kitchen.getTicket(ids.ticket)).resolves.toMatchObject({
      state: 'COMPLETED',
    });

    const pickup = await orders.issuePickupCode(ids.invoice, ids.employee);
    expect(pickup.code).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(await orders.issuePickupCode(ids.invoice, ids.employee)).toEqual(
      pickup,
    );
    const publicStatus = await request(app.getHttpServer())
      .post(`${prefix}/orders/takeaway/pickup/status`)
      .send({ invoiceId: ids.invoice, code: pickup.code })
      .expect(200);
    expect(publicStatus.headers['cache-control']).toBe('no-store');
    expect(publicStatus.body.data).toMatchObject({
      invoiceId: ids.invoice,
      status: 'READY',
      items: [
        {
          id: ids.orderItem,
          name: `Handoff latte ${suffix}`,
          serveStatus: ServeStatus.READY,
        },
      ],
    });
    expect(publicStatus.body.data).not.toHaveProperty('employeeId');
    await request(app.getHttpServer())
      .post(`${prefix}/orders/takeaway/pickup/feedback`)
      .send({ invoiceId: ids.invoice, code: pickup.code, rating: 5 })
      .expect(409);

    const rotated = await orders.rotatePickupCode(
      ids.invoice,
      pickup.code,
      ids.employee,
    );
    expect(rotated.code).not.toBe(pickup.code);
    await request(app.getHttpServer())
      .post(`${prefix}/orders/takeaway/pickup/status`)
      .send({ invoiceId: ids.invoice, code: pickup.code })
      .expect(404);
    await expect(
      orders.handoffWithPickupCode(
        ids.invoice,
        pickup.code,
        ids.orderItem,
        ids.employee,
      ),
    ).rejects.toThrow('Pickup is no longer available.');
    await expect(
      orders.rotatePickupCode(ids.invoice, pickup.code, ids.employee),
    ).rejects.toThrow('Pickup code changed or expired.');
    await orders.revokePickupCode(ids.invoice, rotated.code, ids.employee);
    await request(app.getHttpServer())
      .post(`${prefix}/orders/takeaway/pickup/status`)
      .send({ invoiceId: ids.invoice, code: rotated.code })
      .expect(404);
    const reissued = await orders.issuePickupCode(ids.invoice, ids.employee);
    expect(reissued.code).not.toBe(rotated.code);
    const rotations = await Promise.allSettled([
      orders.rotatePickupCode(ids.invoice, reissued.code, ids.employee),
      orders.rotatePickupCode(ids.invoice, reissued.code, ids.employee),
    ]);
    expect(
      rotations.filter((result) => result.status === 'fulfilled'),
    ).toHaveLength(1);
    expect(
      rotations.filter((result) => result.status === 'rejected'),
    ).toHaveLength(1);
    const currentCode = await orders.issuePickupCode(ids.invoice, ids.employee);
    expect(currentCode.code).not.toBe(reissued.code);

    await prisma.invoice.update({
      where: { id: ids.invoice },
      data: { createdAt: new Date('2025-01-01T05:00:00.000Z') },
    });
    await expect(
      dailyClose.close('2025-01-01', ids.employee),
    ).rejects.toMatchObject({
      constructor: ConflictException,
      response: expect.objectContaining({
        blockers: expect.objectContaining({ unfinishedItems: 1 }),
      }),
    });

    await prisma.invoice.update({
      where: { id: ids.invoice },
      data: {
        createdAt: new Date(),
        paymentStatus: 'REFUNDED',
      },
    });
    await expect(
      orders.handoffWithPickupCode(
        ids.invoice,
        currentCode.code,
        ids.orderItem,
        ids.employee,
      ),
    ).rejects.toThrow('Pickup is no longer available.');
    await prisma.invoice.update({
      where: { id: ids.invoice },
      data: { paymentStatus: 'PAID' },
    });

    await orders.handoffWithPickupCode(
      ids.invoice,
      currentCode.code,
      ids.orderItem,
      ids.employee,
    );
    await orders.handoffWithPickupCode(
      ids.invoice,
      currentCode.code,
      ids.orderItem,
      ids.employee,
    );
    const collectedStatus = await request(app.getHttpServer())
      .post(`${prefix}/orders/takeaway/pickup/status`)
      .send({ invoiceId: ids.invoice, code: currentCode.code })
      .expect(200);
    expect(collectedStatus.body.data.status).toBe('COLLECTED');
    const feedbackInput = {
      invoiceId: ids.invoice,
      code: currentCode.code,
      rating: 5,
      comment: 'Quick pickup',
    };
    const [firstFeedback, repeatedFeedback] = await Promise.all([
      request(app.getHttpServer())
        .post(`${prefix}/orders/takeaway/pickup/feedback`)
        .send(feedbackInput)
        .expect(200),
      request(app.getHttpServer())
        .post(`${prefix}/orders/takeaway/pickup/feedback`)
        .send(feedbackInput)
        .expect(200),
    ]);
    expect(firstFeedback.body.data.id).toBe(repeatedFeedback.body.data.id);
    expect(
      await prisma.takeawayFeedback.count({
        where: { invoiceId: ids.invoice },
      }),
    ).toBe(1);
    await request(app.getHttpServer())
      .post(`${prefix}/orders/takeaway/pickup/feedback`)
      .send({ ...feedbackInput, rating: 1 })
      .expect(409);
    await request(app.getHttpServer())
      .post(`${prefix}/orders/takeaway/pickup/feedback`)
      .send({ ...feedbackInput, rating: 0 })
      .expect(400);
    await expect(
      prisma.takeawayFeedback.update({
        where: { invoiceId: ids.invoice },
        data: { rating: 6 },
      }),
    ).rejects.toThrow();
    const feedbackList = await orders.getTakeawayFeedback({
      from: undefined,
      to: undefined,
      page: 1,
      itemPerPage: 20,
      rating: 5,
    });
    expect(feedbackList.list).toContainEqual(
      expect.objectContaining({
        id: firstFeedback.body.data.id,
        invoice: { invoiceNumber: `HANDOFF-${suffix}` },
      }),
    );
    const after = await orders.getHandoffItems({ page: 1, itemPerPage: 20 });
    expect(after.list.some((item) => item.id === ids.orderItem)).toBe(false);
    const persisted = await prisma.orderItem.findUniqueOrThrow({
      where: { id: ids.orderItem },
    });
    expect(persisted.readyAt).toEqual(ready.readyAt);
    expect(persisted.serveStatus).toBe(ServeStatus.SERVED);
    expect(persisted.isPaid).toBe(true);
    expect(
      await prisma.actionLog.count({
        where: {
          employeeId: ids.employee,
          actionType: 'ORDER_ITEM_STATUS_UPDATED',
        },
      }),
    ).toBe(3);
  });
});
