import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ThrottlerGuard } from '@nestjs/throttler';
import { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import type { App } from 'supertest/types';
import { AppModule } from '../src/app/app.module';
import { TurnstileService } from '../src/app/auth/turnstile.service';
import { OnlineOrdersService } from '../src/app/online-orders/online-orders.service';
import { OrdersService } from '../src/app/orders/orders.service';
import { TakeawayService } from '../src/app/orders/takeaway.service';
import { InventoryConsumptionService } from '../src/app/inventory/services/inventory-consumption.service';
import { InventoryMovementService } from '../src/app/inventory/services/inventory-movement.service';
import { PrismaService } from '../src/common/prisma/prisma.service';
import { initApp } from '../src/init';

describe('Customer orders and ingredient commitments (PostgreSQL)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let online: OnlineOrdersService;
  let orders: OrdersService;
  let takeaway: TakeawayService;
  let consumption: InventoryConsumptionService;
  let movements: InventoryMovementService;
  let throttle: jest.SpyInstance;
  const suffix = randomUUID();
  const ids: Record<string, string> = {};
  const clients: string[] = [];
  const sessions: string[] = [];
  const customerIds: string[] = [];
  const prefix = '/api/v1';

  const dto = () => {
    const clientRequestId = randomUUID();
    clients.push(clientRequestId);
    return {
      clientRequestId,
      pickupName: 'Fixture pickup',
      phoneNumber: '0901234567',
      turnstileToken: 'fixture-human',
      items: [{ menuItemId: ids.menu, quantity: 1 }],
    };
  };
  const customerSession = async (id?: string) => {
    const customer = id
      ? { id }
      : await prisma.customer.create({
          data: {
            googleSubject: `stock-customer-${randomUUID()}`,
            email: 'fixture@example.test',
          },
        });
    if (!id) customerIds.push(customer.id);
    const token = randomBytes(32).toString('base64url');
    const csrf = randomBytes(32).toString('base64url');
    await prisma.customerSession.create({
      data: {
        customerId: customer.id,
        tokenHash: createHash('sha256').update(token).digest('hex'),
        expiresAt: new Date(Date.now() + 86400000),
      },
    });
    return {
      id: customer.id,
      csrf,
      cookie: `customerSession=${token}; customerCsrfToken=${csrf}`,
    };
  };

  beforeAll(async () => {
    const target = new URL(process.env.DATABASE_URL ?? '');
    assert(
      process.env.NODE_ENV === 'test' &&
        ['127.0.0.1', 'localhost'].includes(target.hostname) &&
        target.pathname.endsWith('_test'),
      'Use only an isolated local test database.',
    );
    throttle = jest
      .spyOn(ThrottlerGuard.prototype, 'canActivate')
      .mockResolvedValue(true);
    const module = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(TurnstileService)
      .useValue({ verify: jest.fn().mockResolvedValue(undefined) })
      .compile();
    const server = module.createNestApplication<NestExpressApplication>();
    initApp(server);
    app = server;
    prisma = module.get(PrismaService);
    online = module.get(OnlineOrdersService);
    orders = module.get(OrdersService);
    takeaway = module.get(TakeawayService);
    consumption = module.get(InventoryConsumptionService);
    movements = module.get(InventoryMovementService);
    await app.init();
    ids.position = (
      await prisma.position.create({
        data: { name: `Stock ${suffix}`, salary: 0 },
      })
    ).id;
    ids.employee = (
      await prisma.employee.create({
        data: {
          username: `stock-${suffix}`,
          email: `stock-${suffix}@example.test`,
          fullName: 'Stock fixture',
          password: 'not-used',
          positionId: ids.position,
        },
      })
    ).id;
    ids.category = (
      await prisma.menuCategory.create({
        data: { name: `Stock menu ${suffix}` },
      })
    ).id;
    ids.station = (
      await prisma.kitchenStation.create({
        data: { name: `Stock bar ${suffix}`, code: `S-${suffix}` },
      })
    ).id;
    ids.unit = (
      await prisma.unit.create({ data: { name: `Stock kg ${suffix}` } })
    ).id;
    ids.inventoryCategory = (
      await prisma.inventoryCategory.create({
        data: { name: `Stock ingredients ${suffix}` },
      })
    ).id;
    ids.stock = (
      await prisma.inventoryItem.create({
        data: {
          name: `Stock milk ${suffix}`,
          unitId: ids.unit,
          categoryId: ids.inventoryCategory,
          stock: '1',
          averageUnitCost: '100000',
        },
      })
    ).id;
    for (const key of ['menu', 'secondMenu']) {
      ids[key] = (
        await prisma.menuItem.create({
          data: {
            name: `${key} ${suffix}`,
            categoryId: ids.category,
            kitchenStationId: ids.station,
            price: '30000',
            ingredients: {
              create: { inventoryItemId: ids.stock, quantity: '0.6' },
            },
          },
        })
      ).id;
    }
    const group = await prisma.menuItemOptionGroup.create({
      data: {
        menuItemId: ids.menu,
        name: 'Extra milk',
        minSelected: 0,
        maxSelected: 1,
        options: {
          create: {
            name: 'Extra',
            priceDelta: '5000',
            ingredients: {
              create: { inventoryItemId: ids.stock, quantity: '0.2' },
            },
          },
        },
      },
      include: { options: true },
    });
    ids.option = group.options[0].id;
  });

  afterAll(async () => {
    try {
      if (!prisma) return;
      const requests = await prisma.onlineOrderRequest.findMany({
        where: { clientRequestId: { in: clients } },
        select: { id: true, orderSessionId: true },
      });
      const sessionIds = [
        ...sessions,
        ...requests.flatMap((row) =>
          row.orderSessionId ? [row.orderSessionId] : [],
        ),
      ];
      const orderItems = await prisma.orderItem.findMany({
        where: { orderSessionId: { in: sessionIds } },
        select: { id: true },
      });
      const itemIds = orderItems.map((row) => row.id);
      await prisma
        .getExtendedClient()
        .$transaction((tx) => consumption.releaseReservations(tx, itemIds));
      await prisma.onlineOrderRequest.deleteMany({
        where: { clientRequestId: { in: clients } },
      });
      await prisma.outboxEvent.deleteMany({
        where: {
          aggregateId: {
            in: [...sessionIds, ...itemIds, ...requests.map((row) => row.id)],
          },
        },
      });
      await prisma.printJob.deleteMany({
        where: { kitchenTicket: { orderSessionId: { in: sessionIds } } },
      });
      await prisma.inventoryWaste.deleteMany({
        where: { orderItemId: { in: itemIds } },
      });
      await prisma.inventoryTransaction.deleteMany({
        where: { orderItemId: { in: itemIds } },
      });
      await prisma.orderItemIngredientSnapshot.deleteMany({
        where: { orderItemId: { in: itemIds } },
      });
      await prisma.kitchenTicketItem.deleteMany({
        where: { orderItemId: { in: itemIds } },
      });
      await prisma.kitchenTicket.deleteMany({
        where: { orderSessionId: { in: sessionIds } },
      });
      await prisma.takeawayFeedback.deleteMany({
        where: { invoice: { orderSessionId: { in: sessionIds } } },
      });
      await prisma.orderItem.deleteMany({ where: { id: { in: itemIds } } });
      await prisma.invoice.deleteMany({
        where: { orderSessionId: { in: sessionIds } },
      });
      await prisma.orderSession.deleteMany({
        where: { id: { in: sessionIds } },
      });
      await prisma.customer.deleteMany({ where: { id: { in: customerIds } } });
      await prisma.menuItemIngredient.deleteMany({
        where: { menuItemId: { in: [ids.menu, ids.secondMenu] } },
      });
      await prisma.menuItem.deleteMany({
        where: { id: { in: [ids.menu, ids.secondMenu] } },
      });
      await prisma.inventoryItem.deleteMany({ where: { id: ids.stock } });
      await prisma.inventoryCategory.deleteMany({
        where: { id: ids.inventoryCategory },
      });
      await prisma.unit.deleteMany({ where: { id: ids.unit } });
      await prisma.menuCategory.deleteMany({ where: { id: ids.category } });
      await prisma.kitchenStation.deleteMany({ where: { id: ids.station } });
      await prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(
          "SET LOCAL app.allow_audit_log_mutation = 'on'",
        );
        await tx.actionLog.deleteMany({ where: { employeeId: ids.employee } });
      });
      await prisma.idempotencyRequest.deleteMany({
        where: { employeeId: ids.employee },
      });
      await prisma.employee.deleteMany({ where: { id: ids.employee } });
      await prisma.position.deleteMany({ where: { id: ids.position } });
    } finally {
      await app?.close();
      throttle?.mockRestore();
    }
  });

  it('quotes the entire basket including repeated lines, shared ingredients and toppings without reserving', async () => {
    const quote = await request(app.getHttpServer())
      .post(`${prefix}/online-orders/quote`)
      .send({
        items: [
          { menuItemId: ids.menu, quantity: 1, optionIds: [ids.option] },
          { menuItemId: ids.secondMenu, quantity: 1 },
        ],
      })
      .expect(200);
    expect(quote.body.data).toMatchObject({
      canFulfill: false,
      reason: 'INVENTORY_INSUFFICIENT_STOCK',
      subtotal: '65000.00',
    });
    expect(JSON.stringify(quote.body)).not.toContain(ids.stock);
    expect(
      (
        await prisma.inventoryItem.findUniqueOrThrow({
          where: { id: ids.stock },
        })
      ).reservedStock.isZero(),
    ).toBe(true);
    expect(
      (
        await online.quoteBasket({
          items: [{ menuItemId: ids.menu, quantity: 1 }],
        })
      ).canFulfill,
    ).toBe(true);
    expect(
      (
        await online.quoteBasket({
          items: [
            { menuItemId: ids.menu, quantity: 1 },
            { menuItemId: ids.menu, quantity: 1 },
          ],
        })
      ).canFulfill,
    ).toBe(false);
  });

  it('accepts only one competing order and prevents POS, manual exports and recounts from consuming its reservation', async () => {
    const [a, b] = await Promise.all([
      online.createPublicRequest(dto()),
      online.createPublicRequest(dto()),
    ]);
    const results = await Promise.allSettled([
      online.accept(a.requestId, ids.employee),
      online.accept(b.requestId, ids.employee),
    ]);
    expect(results.filter((row) => row.status === 'fulfilled')).toHaveLength(1);
    const winner = results[0].status === 'fulfilled' ? a : b;
    let stock = await prisma.inventoryItem.findUniqueOrThrow({
      where: { id: ids.stock },
    });
    expect(stock.stock.toString()).toBe('1');
    expect(stock.reservedStock.toString()).toBe('0.6');
    expect(
      await prisma.orderSession.count({ where: { employeeId: ids.employee } }),
    ).toBe(1);
    expect(
      await prisma.inventoryTransaction.count({
        where: { inventoryItemId: ids.stock },
      }),
    ).toBe(0);
    await expect(
      prisma.inventoryItem.update({
        where: { id: ids.stock },
        data: { stock: '0.1' },
      }),
    ).rejects.toThrow();
    await expect(
      movements.exportItem(ids.stock, ids.employee, {
        quantity: '0.5',
        note: 'Rejected fixture export',
        idempotencyKey: randomUUID(),
        transactionDate: undefined,
      }),
    ).rejects.toThrow();
    const session = await orders.openSession({ employeeId: ids.employee });
    sessions.push(session.id);
    await orders.addOrderItems(
      session.id,
      {
        items: [{ menuItemId: ids.menu, quantity: 1 }],
        idempotencyKey: randomUUID(),
      },
      ids.employee,
    );
    const item = await prisma.orderItem.findFirstOrThrow({
      where: { orderSessionId: session.id },
    });
    await expect(
      orders.updateItemStatus(item.id, ids.employee, {
        serveStatus: 'COOKING',
      }),
    ).rejects.toThrow();
    await online.cancelPublicRequest({
      requestId: winner.requestId,
      accessToken: winner.accessToken,
    });
    stock = await prisma.inventoryItem.findUniqueOrThrow({
      where: { id: ids.stock },
    });
    expect(stock.stock.toString()).toBe('1');
    expect(stock.reservedStock.isZero()).toBe(true);
    await orders.updateItemStatus(item.id, ids.employee, {
      serveStatus: 'COOKING',
    });
    await orders.updateItemStatus(item.id, ids.employee, {
      serveStatus: 'COOKING',
    });
    expect(
      await prisma.inventoryTransaction.count({
        where: { orderItemId: item.id },
      }),
    ).toBe(1);
    expect(
      (
        await prisma.inventoryItem.findUniqueOrThrow({
          where: { id: ids.stock },
        })
      ).stock.toString(),
    ).toBe('0.4');
  });

  it('consumes its own hold once, releases pending cancellations and records prepared cancellations as waste', async () => {
    await prisma.inventoryItem.update({
      where: { id: ids.stock },
      data: { stock: '3' },
    });
    const pending = await online.createPublicRequest(dto());
    await online.accept(pending.requestId, ids.employee);
    await online.cancelAccepted(
      pending.requestId,
      ids.employee,
      'Customer changed plans',
    );
    let stock = await prisma.inventoryItem.findUniqueOrThrow({
      where: { id: ids.stock },
    });
    expect(stock.stock.toString()).toBe('3');
    expect(stock.reservedStock.isZero()).toBe(true);
    const prepared = await online.createPublicRequest(dto());
    const accepted = await online.accept(prepared.requestId, ids.employee);
    const item = await prisma.orderItem.findFirstOrThrow({
      where: { orderSessionId: accepted.orderSessionId },
    });
    await orders.updateItemStatus(item.id, ids.employee, {
      serveStatus: 'COOKING',
    });
    stock = await prisma.inventoryItem.findUniqueOrThrow({
      where: { id: ids.stock },
    });
    expect(stock.stock.toString()).toBe('2.4');
    expect(stock.reservedStock.isZero()).toBe(true);
    expect(
      await prisma.inventoryReservation.count({
        where: { orderItemId: item.id },
      }),
    ).toBe(0);
    await online.cancelAccepted(
      prepared.requestId,
      ids.employee,
      'Prepared order cancelled',
    );
    expect(
      await prisma.inventoryWaste.count({ where: { orderItemId: item.id } }),
    ).toBe(1);
    expect(
      (
        await prisma.inventoryItem.findUniqueOrThrow({
          where: { id: ids.stock },
        })
      ).stock.toString(),
    ).toBe('2.4');
  });

  it('shows only public feedback to the owner after tracking expiry and never exposes internal resolution notes', async () => {
    const owner = await customerSession();
    const other = await customerSession();
    const input = dto();
    const created = await online.createPublicRequest(
      input,
      undefined,
      owner.id,
    );
    const session = await prisma.orderSession.create({
      data: { employeeId: ids.employee, sessionStatus: 'COMPLETED' },
    });
    sessions.push(session.id);
    const invoice = await prisma.invoice.create({
      data: {
        invoiceNumber: `FEEDBACK-${suffix}`,
        subTotal: 30000,
        totalAmount: 30000,
        paymentStatus: 'PAID',
        orderSessionId: session.id,
        employeeId: ids.employee,
        orderItems: {
          create: {
            orderSessionId: session.id,
            menuItemId: ids.menu,
            quantity: 1,
            priceAtTime: 30000,
            serveStatus: 'SERVED',
            isPaid: true,
          },
        },
      },
    });
    await prisma.onlineOrderRequest.update({
      where: { id: created.requestId },
      data: {
        status: 'ACCEPTED',
        orderSessionId: session.id,
        reviewedAt: new Date(),
        reviewedById: ids.employee,
      },
    });
    const feedback = await prisma.takeawayFeedback.create({
      data: { invoiceId: invoice.id, rating: 1, comment: 'Delayed pickup' },
    });
    await takeaway.resolveTakeawayFeedback(feedback.id, ids.employee, {
      resolutionNote: 'Internal staff review: do not publish this note',
      customerReply: 'We contacted you and addressed the delay.',
    });
    const publicRead = await online.trackPublicRequest({
      requestId: created.requestId,
      accessToken: created.accessToken,
    });
    expect(publicRead.feedback).toEqual([
      expect.objectContaining({
        id: feedback.id,
        customerReply: 'We contacted you and addressed the delay.',
      }),
    ]);
    expect(JSON.stringify(publicRead)).not.toContain('Internal staff review');
    expect(JSON.stringify(publicRead)).not.toContain('resolvedById');
    expect(publicRead).not.toHaveProperty('invoices');
    await prisma.onlineOrderRequest.update({
      where: { id: created.requestId },
      data: { createdAt: new Date(Date.now() - 90 * 86400000) },
    });
    await request(app.getHttpServer())
      .post(`${prefix}/online-orders/requests/status`)
      .send({ requestId: created.requestId, accessToken: created.accessToken })
      .expect(404);
    const history = await request(app.getHttpServer())
      .get(`${prefix}/customers/orders/${created.requestId}`)
      .set('Cookie', owner.cookie)
      .expect(200);
    expect(history.body.data.feedback[0]).toMatchObject({
      id: feedback.id,
      customerReply: 'We contacted you and addressed the delay.',
    });
    expect(JSON.stringify(history.body.data)).not.toContain(
      'Internal staff review',
    );
    expect(JSON.stringify(history.body.data)).not.toContain('resolvedById');
    await request(app.getHttpServer())
      .get(`${prefix}/customers/orders/${created.requestId}`)
      .set('Cookie', other.cookie)
      .expect(404);
  });

  it('keeps customer history private across devices, survives tracking expiry and re-quotes old orders', async () => {
    const a = await customerSession();
    const b = await customerSession();
    const input = { ...dto(), expectedCustomerId: a.id };
    const created = await request(app.getHttpServer())
      .post(`${prefix}/customers/orders`)
      .set('Cookie', a.cookie)
      .set('X-CSRF-Token', a.csrf)
      .send(input)
      .expect(201);
    const orderId = created.body.data.requestId as string;
    const replay = await request(app.getHttpServer())
      .post(`${prefix}/customers/orders`)
      .set('Cookie', a.cookie)
      .set('X-CSRF-Token', a.csrf)
      .send(input)
      .expect(201);
    expect(replay.body.data.requestId).toBe(orderId);
    expect(
      (
        await prisma.onlineOrderRequest.findUniqueOrThrow({
          where: { id: orderId },
        })
      ).customerId,
    ).toBe(a.id);
    await request(app.getHttpServer())
      .get(`${prefix}/customers/orders`)
      .expect(401);
    await request(app.getHttpServer())
      .post(`${prefix}/customers/orders`)
      .set('Cookie', a.cookie)
      .send(input)
      .expect(403);
    await request(app.getHttpServer())
      .post(`${prefix}/customers/orders`)
      .set('Cookie', a.cookie)
      .set('X-CSRF-Token', a.csrf)
      .send({ ...input, expectedCustomerId: b.id })
      .expect(409);
    await request(app.getHttpServer())
      .post(`${prefix}/customers/orders`)
      .set('Cookie', a.cookie)
      .set('X-CSRF-Token', a.csrf)
      .send({ ...input, customerId: b.id })
      .expect(400);
    await request(app.getHttpServer())
      .post(`${prefix}/customers/orders`)
      .set('Cookie', b.cookie)
      .set('X-CSRF-Token', b.csrf)
      .send({ ...input, expectedCustomerId: b.id })
      .expect(409);
    const { expectedCustomerId: _expected, ...guestInput } = input;
    await request(app.getHttpServer())
      .post(`${prefix}/online-orders/requests`)
      .send(guestInput)
      .expect(409);
    await request(app.getHttpServer())
      .get(`${prefix}/customers/orders/${orderId}`)
      .set('Cookie', b.cookie)
      .expect(404);
    await request(app.getHttpServer())
      .get(`${prefix}/customers/orders/${orderId}/reorder-template`)
      .set('Cookie', b.cookie)
      .expect(404);
    const guest = await online.createPublicRequest(dto());
    await request(app.getHttpServer())
      .get(`${prefix}/customers/orders/${guest.requestId}`)
      .set('Cookie', a.cookie)
      .expect(404);
    const old = new Date(Date.now() - 210 * 86400000);
    await prisma.onlineOrderRequest.update({
      where: { id: orderId },
      data: { createdAt: old, expiresAt: new Date(old.getTime() + 30 * 60000) },
    });
    const secondDevice = await customerSession(a.id);
    const history = await request(app.getHttpServer())
      .get(`${prefix}/customers/orders`)
      .set('Cookie', secondDevice.cookie)
      .expect(200);
    expect(JSON.stringify(history.body.data)).toContain(orderId);
    expect(JSON.stringify(history.body.data)).not.toContain(guest.requestId);
    const detail = await request(app.getHttpServer())
      .get(`${prefix}/customers/orders/${orderId}`)
      .set('Cookie', secondDevice.cookie)
      .expect(200);
    expect(detail.body.data.status).toBe('EXPIRED');
    expect(detail.body.data.items[0].quotedUnitPrice).toBe(30000);
    expect(detail.body.data).not.toHaveProperty('accessToken');
    expect(detail.body.data).not.toHaveProperty('phoneNumber');
    await prisma.menuItem.update({
      where: { id: ids.menu },
      data: { price: '35000' },
    });
    const template = await request(app.getHttpServer())
      .get(`${prefix}/customers/orders/${orderId}/reorder-template`)
      .set('Cookie', secondDevice.cookie)
      .expect(200);
    expect(template.body.data.quote).toMatchObject({
      previousSubtotal: '30000.00',
      currentSubtotal: '35000.00',
      canSubmit: true,
      stockAvailable: true,
    });
    await prisma.menuItem.update({
      where: { id: ids.menu },
      data: { isAvailable: false },
    });
    const unavailable = await request(app.getHttpServer())
      .get(`${prefix}/customers/orders/${orderId}/reorder-template`)
      .set('Cookie', secondDevice.cookie)
      .expect(200);
    expect(unavailable.body.data.quote.canSubmit).toBe(false);
    await prisma.customer.update({
      where: { id: a.id },
      data: { isActive: false },
    });
    await request(app.getHttpServer())
      .get(`${prefix}/customers/orders`)
      .set('Cookie', secondDevice.cookie)
      .expect(401);
  });
});
