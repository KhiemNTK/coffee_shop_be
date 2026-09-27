import { randomUUID } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { OnlineOrderStatus, Prisma, ServeStatus } from '@prisma/client';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from '../src/app/app.module';
import { OnlineOrdersService } from '../src/app/online-orders/online-orders.service';
import { OrdersService } from '../src/app/orders/orders.service';
import { PrismaService } from '../src/common/prisma/prisma.service';
import { initApp } from '../src/init';

describe('Remote takeaway orders (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let onlineOrders: OnlineOrdersService;
  let orders: OrdersService;
  let prefix: string;
  const suffix = randomUUID();
  const ids: Record<string, string> = {};
  const clientRequestIds: string[] = [];

  const createDto = (clientRequestId = randomUUID()) => ({
    clientRequestId,
    pickupName: 'Test pickup',
    phoneNumber: '0901234567',
    items: [{ menuItemId: ids.menuItem, quantity: 2, note: 'Less ice' }],
  });

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    const expressApp = module.createNestApplication<NestExpressApplication>();
    initApp(expressApp);
    app = expressApp;
    prisma = module.get(PrismaService);
    onlineOrders = module.get(OnlineOrdersService);
    orders = module.get(OrdersService);
    prefix = module.get(ConfigService).get<string>('APP_PREFIX', '/api/v1');
    await app.init();

    const position = await prisma.position.create({
      data: { name: `Online position ${suffix}`, salary: 0 },
    });
    ids.position = position.id;
    const employee = await prisma.employee.create({
      data: {
        email: `online-${suffix}@example.com`,
        username: `online-${suffix}`,
        fullName: 'Online reviewer',
        password: 'test-only',
        positionId: position.id,
      },
    });
    ids.employee = employee.id;
    const category = await prisma.menuCategory.create({
      data: { name: `Online category ${suffix}` },
    });
    ids.category = category.id;
    const station = await prisma.kitchenStation.create({
      data: { code: `O-${suffix}`, name: `Online station ${suffix}` },
    });
    ids.station = station.id;
    const menuItem = await prisma.menuItem.create({
      data: {
        name: `Online coffee ${suffix}`,
        categoryId: category.id,
        kitchenStationId: station.id,
        price: 25_000,
      },
    });
    ids.menuItem = menuItem.id;
  });

  afterAll(async () => {
    try {
      const requests = await prisma.onlineOrderRequest.findMany({
        where: { clientRequestId: { in: clientRequestIds } },
        select: { id: true, orderSessionId: true },
      });
      const requestIds = requests.map((entry) => entry.id);
      const sessionIds = requests.flatMap((entry) =>
        entry.orderSessionId ? [entry.orderSessionId] : [],
      );
      await prisma.onlineOrderRequest.deleteMany({
        where: { id: { in: requestIds } },
      });
      await prisma.outboxEvent.deleteMany({
        where: { aggregateId: { in: sessionIds } },
      });
      await prisma.kitchenTicketItem.deleteMany({
        where: { ticket: { orderSessionId: { in: sessionIds } } },
      });
      await prisma.kitchenTicket.deleteMany({
        where: { orderSessionId: { in: sessionIds } },
      });
      await prisma.orderItem.deleteMany({
        where: { orderSessionId: { in: sessionIds } },
      });
      await prisma.orderSession.deleteMany({
        where: { id: { in: sessionIds } },
      });
      if (ids.menuItem)
        await prisma.menuItem.deleteMany({ where: { id: ids.menuItem } });
      if (ids.station)
        await prisma.kitchenStation.deleteMany({
          where: { id: ids.station },
        });
      if (ids.category)
        await prisma.menuCategory.deleteMany({
          where: { id: ids.category },
        });
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

  it('creates a private, idempotent request and rejects conflicting retries', async () => {
    const dto = createDto();
    clientRequestIds.push(dto.clientRequestId);
    const created = await request(app.getHttpServer())
      .post(`${prefix}/online-orders/requests`)
      .send(dto)
      .expect(201);
    expect(created.headers['cache-control']).toBe('no-store');
    expect(created.body.data).toMatchObject({
      status: OnlineOrderStatus.PENDING,
      quotedSubtotal: 50_000,
    });
    expect(created.body.data.accessToken).toMatch(/^[0-9a-f]{64}$/);

    const retried = await request(app.getHttpServer())
      .post(`${prefix}/online-orders/requests`)
      .send(dto)
      .expect(201);
    expect(retried.body.data).toEqual(created.body.data);
    await request(app.getHttpServer())
      .post(`${prefix}/online-orders/requests`)
      .send({ ...dto, pickupName: 'Different customer' })
      .expect(409);

    const access = {
      requestId: created.body.data.requestId as string,
      accessToken: created.body.data.accessToken as string,
    };
    expect(
      (await onlineOrders.findPending({ page: 1, itemPerPage: 50 })).list,
    ).toContainEqual(expect.objectContaining({ id: access.requestId }));
    await request(app.getHttpServer())
      .post(`${prefix}/online-orders/requests/status`)
      .send({ ...access, accessToken: '0'.repeat(64) })
      .expect(404);
    const tracked = await request(app.getHttpServer())
      .post(`${prefix}/online-orders/requests/status`)
      .send(access)
      .expect(200);
    expect(tracked.body.data).toMatchObject({
      status: OnlineOrderStatus.PENDING,
      isPaid: false,
      fulfillmentStatus: null,
    });
    expect(tracked.body.data).not.toHaveProperty('phoneNumber');

    await prisma.menuItem.update({
      where: { id: ids.menuItem },
      data: { price: 30_000 },
    });
    await expect(
      onlineOrders.accept(access.requestId, ids.employee),
    ).rejects.toThrow('Menu prices changed since the order was placed.');
    expect(
      await prisma.orderSession.count({
        where: { onlineOrderRequest: { id: access.requestId } },
      }),
    ).toBe(0);
    await prisma.menuItem.update({
      where: { id: ids.menuItem },
      data: { price: 25_000 },
    });

    const attempts = await Promise.allSettled([
      onlineOrders.accept(access.requestId, ids.employee),
      onlineOrders.accept(access.requestId, ids.employee),
    ]);
    expect(
      attempts.filter((attempt) => attempt.status === 'fulfilled'),
    ).toHaveLength(1);
    const accepted = attempts.find((attempt) => attempt.status === 'fulfilled');
    if (!accepted || accepted.status !== 'fulfilled')
      throw new Error('No accepted order');
    const sessionId = accepted.value.orderSessionId;
    const session = await prisma.orderSession.findUniqueOrThrow({
      where: { id: sessionId },
      include: { orderItems: true, kitchenTickets: true },
    });
    expect(session.tableId).toBeNull();
    expect(session.orderItems).toHaveLength(1);
    expect(session.orderItems[0].priceAtTime).toEqual(
      new Prisma.Decimal(25_000),
    );
    expect(session.kitchenTickets).toHaveLength(1);
    expect(
      await prisma.onlineOrderRequest.findUniqueOrThrow({
        where: { id: access.requestId },
        select: { status: true, orderSessionId: true },
      }),
    ).toEqual({
      status: OnlineOrderStatus.ACCEPTED,
      orderSessionId: sessionId,
    });
    expect(
      (await onlineOrders.findPending({ page: 1, itemPerPage: 50 })).list,
    ).not.toContainEqual(expect.objectContaining({ id: access.requestId }));

    await onlineOrders.trackPublicRequest(access);
    await expect(onlineOrders.cancelPublicRequest(access)).rejects.toThrow(
      'Order request can no longer be cancelled.',
    );
    await onlineOrders.findOne(access.requestId);
    await orders.updateItemStatus(session.orderItems[0].id, ids.employee, {
      serveStatus: ServeStatus.COOKING,
    });
    await orders.updateItemStatus(session.orderItems[0].id, ids.employee, {
      serveStatus: ServeStatus.READY,
    });
    expect(
      (await onlineOrders.trackPublicRequest(access)).fulfillmentStatus,
    ).toBe('READY');
  });

  it('allows cancellation before review and leaves no order session', async () => {
    const dto = createDto();
    clientRequestIds.push(dto.clientRequestId);
    const created = await onlineOrders.createPublicRequest(dto);
    const access = {
      requestId: created.requestId,
      accessToken: created.accessToken,
    };
    expect(await onlineOrders.cancelPublicRequest(access)).toEqual({
      requestId: created.requestId,
      status: OnlineOrderStatus.CANCELLED,
    });
    await expect(
      onlineOrders.accept(created.requestId, ids.employee),
    ).rejects.toThrow('Order request is no longer pending.');
    expect((await onlineOrders.trackPublicRequest(access)).status).toBe(
      OnlineOrderStatus.CANCELLED,
    );
  });

  it('collapses concurrent retries with the same client request ID', async () => {
    const dto = createDto();
    clientRequestIds.push(dto.clientRequestId);
    const [first, second] = await Promise.all([
      onlineOrders.createPublicRequest(dto),
      onlineOrders.createPublicRequest(dto),
    ]);
    expect(second).toEqual(first);
    expect(
      await prisma.onlineOrderRequest.count({
        where: { clientRequestId: dto.clientRequestId },
      }),
    ).toBe(1);
  });

  it('rejects an invalid callback number before writing a request', async () => {
    const dto = createDto();
    await request(app.getHttpServer())
      .post(`${prefix}/online-orders/requests`)
      .send({ ...dto, phoneNumber: '++++++++' })
      .expect(400);
    expect(
      await prisma.onlineOrderRequest.count({
        where: { clientRequestId: dto.clientRequestId },
      }),
    ).toBe(0);
  });

  it('does not offer or accept items from an inactive kitchen station', async () => {
    await prisma.kitchenStation.update({
      where: { id: ids.station },
      data: { isActive: false },
    });
    try {
      const menu = await request(app.getHttpServer())
        .get(`${prefix}/menu/public/items`)
        .expect(200);
      expect(menu.body.data.list).not.toContainEqual(
        expect.objectContaining({ id: ids.menuItem }),
      );
      await request(app.getHttpServer())
        .post(`${prefix}/online-orders/requests`)
        .send(createDto())
        .expect(404);
    } finally {
      await prisma.kitchenStation.update({
        where: { id: ids.station },
        data: { isActive: true },
      });
    }
  });

  it('rejects and reports expired requests without a job', async () => {
    const rejectedDto = createDto();
    clientRequestIds.push(rejectedDto.clientRequestId);
    const rejected = await onlineOrders.createPublicRequest(rejectedDto);
    await onlineOrders.reject(rejected.requestId, ids.employee, 'Sold out');
    const rejectedStatus = await onlineOrders.trackPublicRequest({
      requestId: rejected.requestId,
      accessToken: rejected.accessToken,
    });
    expect(rejectedStatus).toMatchObject({
      status: OnlineOrderStatus.REJECTED,
      rejectionReason: 'Sold out',
    });

    const expiredDto = createDto();
    clientRequestIds.push(expiredDto.clientRequestId);
    const expired = await onlineOrders.createPublicRequest(expiredDto);
    const createdAt = (
      await prisma.onlineOrderRequest.findUniqueOrThrow({
        where: { id: expired.requestId },
        select: { createdAt: true },
      })
    ).createdAt;
    await prisma.onlineOrderRequest.update({
      where: { id: expired.requestId },
      data: { expiresAt: new Date(createdAt.getTime() + 1) },
    });
    expect(
      (
        await onlineOrders.trackPublicRequest({
          requestId: expired.requestId,
          accessToken: expired.accessToken,
        })
      ).status,
    ).toBe('EXPIRED');
    await expect(
      onlineOrders.accept(expired.requestId, ids.employee),
    ).rejects.toThrow('Order request is no longer pending.');
  });
});
