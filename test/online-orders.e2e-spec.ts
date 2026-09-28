import { randomBytes, randomUUID } from 'node:crypto';
import { ForbiddenException, INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { ThrottlerGuard } from '@nestjs/throttler';
import {
  FundType,
  OnlineOrderStatus,
  PrintJobStatus,
  Prisma,
  ServeStatus,
  SessionStatus,
} from '@prisma/client';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from '../src/app/app.module';
import { TurnstileService } from '../src/app/auth/turnstile.service';
import { OnlineOrdersService } from '../src/app/online-orders/online-orders.service';
import { vietnamDate } from '../src/app/online-orders/pickup-schedule';
import { MenuService } from '../src/app/menu/menu.service';
import { OrdersService } from '../src/app/orders/orders.service';
import { CashierShiftsService } from '../src/app/cashier-shifts/cashier-shifts.service';
import { ReportsService } from '../src/app/reports/reports.service';
import { PrismaService } from '../src/common/prisma/prisma.service';
import { initApp } from '../src/init';

describe('Remote takeaway orders (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let onlineOrders: OnlineOrdersService;
  let turnstile: TurnstileService;
  let orders: OrdersService;
  let menu: MenuService;
  let shifts: CashierShiftsService;
  let reports: ReportsService;
  let throttleSpy: jest.SpyInstance;
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
    throttleSpy = jest
      .spyOn(ThrottlerGuard.prototype, 'canActivate')
      .mockResolvedValue(true);
    const module = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    const expressApp = module.createNestApplication<NestExpressApplication>();
    initApp(expressApp);
    app = expressApp;
    prisma = module.get(PrismaService);
    onlineOrders = module.get(OnlineOrdersService);
    turnstile = module.get(TurnstileService);
    orders = module.get(OrdersService);
    menu = module.get(MenuService);
    shifts = module.get(CashierShiftsService);
    reports = module.get(ReportsService);
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
      const orderItems = await prisma.orderItem.findMany({
        where: { orderSessionId: { in: sessionIds } },
        select: { id: true },
      });
      const orderItemIds = orderItems.map((item) => item.id);
      const invoices = await prisma.invoice.findMany({
        where: { orderSessionId: { in: sessionIds } },
        select: { id: true },
      });
      const invoiceIds = invoices.map((invoice) => invoice.id);
      await prisma.onlineOrderRequest.deleteMany({
        where: { id: { in: requestIds } },
      });
      await prisma.outboxEvent.deleteMany({
        where: {
          aggregateId: { in: [...sessionIds, ...orderItemIds, ...invoiceIds] },
        },
      });
      await prisma.printJob.deleteMany({
        where: { invoiceId: { in: invoiceIds } },
      });
      await prisma.printJob.deleteMany({
        where: { kitchenTicket: { orderSessionId: { in: sessionIds } } },
      });
      await prisma.cashTransaction.deleteMany({
        where: { invoiceId: { in: invoiceIds } },
      });
      await prisma.inventoryWaste.deleteMany({
        where: { orderItemId: { in: orderItemIds } },
      });
      await prisma.inventoryTransaction.deleteMany({
        where: { orderItemId: { in: orderItemIds } },
      });
      await prisma.orderItemIngredientSnapshot.deleteMany({
        where: { orderItemId: { in: orderItemIds } },
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
      await prisma.invoice.deleteMany({ where: { id: { in: invoiceIds } } });
      await prisma.orderSession.deleteMany({
        where: { id: { in: sessionIds } },
      });
      if (ids.shift)
        await prisma.cashierShift.deleteMany({ where: { id: ids.shift } });
      if (ids.fund) await prisma.fund.deleteMany({ where: { id: ids.fund } });
      if (ids.menuItem)
        await prisma.menuItemIngredient.deleteMany({
          where: { menuItemId: ids.menuItem },
        });
      if (ids.menuItem)
        await prisma.menuItem.deleteMany({ where: { id: ids.menuItem } });
      if (ids.inventoryItem)
        await prisma.inventoryItem.deleteMany({
          where: { id: ids.inventoryItem },
        });
      if (ids.inventoryCategory)
        await prisma.inventoryCategory.deleteMany({
          where: { id: ids.inventoryCategory },
        });
      if (ids.unit) await prisma.unit.deleteMany({ where: { id: ids.unit } });
      if (ids.station)
        await prisma.kitchenStation.deleteMany({
          where: { id: ids.station },
        });
      if (ids.printDevice)
        await prisma.printDevice.deleteMany({
          where: { id: ids.printDevice },
        });
      if (ids.category)
        await prisma.menuCategory.deleteMany({
          where: { id: ids.category },
        });
      if (ids.employee) {
        await prisma.idempotencyRequest.deleteMany({
          where: { employeeId: ids.employee },
        });
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
      throttleSpy?.mockRestore();
    }
  });

  it('verifies new requests but preserves idempotent retries without a fresh challenge', async () => {
    const dto = createDto();
    clientRequestIds.push(dto.clientRequestId);
    const verify = jest
      .spyOn(turnstile, 'verify')
      .mockImplementation((token, _ip, action) =>
        token === 'challenge' && action === 'online_order'
          ? Promise.resolve()
          : Promise.reject(new ForbiddenException()),
      );
    try {
      await request(app.getHttpServer())
        .post(`${prefix}/online-orders/requests`)
        .send(dto)
        .expect(403);
      const created = await request(app.getHttpServer())
        .post(`${prefix}/online-orders/requests`)
        .send({ ...dto, turnstileToken: 'challenge' })
        .expect(201);
      const replay = await request(app.getHttpServer())
        .post(`${prefix}/online-orders/requests`)
        .send(dto)
        .expect(201);
      expect(replay.body.data).toEqual(created.body.data);
      expect(verify).toHaveBeenCalledTimes(2);
      expect(verify).toHaveBeenCalledWith(
        'challenge',
        expect.any(String),
        'online_order',
      );
    } finally {
      verify.mockRestore();
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
    await request(app.getHttpServer())
      .post(`${prefix}/online-orders/requests/reorder-template`)
      .send({ ...access, accessToken: '0'.repeat(64) })
      .expect(404);
    const template = await request(app.getHttpServer())
      .post(`${prefix}/online-orders/requests/reorder-template`)
      .send(access)
      .expect(200);
    expect(template.body.data.items).toEqual([
      {
        menuItemId: ids.menuItem,
        quantity: 2,
        note: 'Less ice',
        optionIds: [],
      },
    ]);
    expect(template.body.data).not.toHaveProperty('phoneNumber');

    await prisma.menuItem.update({
      where: { id: ids.menuItem },
      data: { price: 30_000 },
    });
    await expect(
      onlineOrders.accept(access.requestId, ids.employee),
    ).rejects.toThrow(
      'Menu price or options changed since the order was placed.',
    );
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
    await onlineOrders.findOne(access.requestId);
    await orders.updateItemStatus(session.orderItems[0].id, ids.employee, {
      serveStatus: ServeStatus.COOKING,
    });
    await expect(onlineOrders.cancelPublicRequest(access)).rejects.toThrow(
      'Preparation or printing has started',
    );
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

  it('lets the customer cancel before preparation and atomically cancels queued kitchen printing', async () => {
    const device = await prisma.printDevice.create({
      data: {
        name: `Online printer ${suffix}`,
        type: 'KITCHEN',
        paperSize: '80mm',
        apiKeyHash: randomBytes(32).toString('hex'),
      },
    });
    ids.printDevice = device.id;
    await prisma.kitchenStation.update({
      where: { id: ids.station },
      data: { printDeviceId: device.id },
    });
    try {
      const dto = createDto();
      clientRequestIds.push(dto.clientRequestId);
      const created = await onlineOrders.createPublicRequest(dto);
      const accepted = await onlineOrders.accept(
        created.requestId,
        ids.employee,
      );
      const access = {
        requestId: created.requestId,
        accessToken: created.accessToken,
      };
      const job = await prisma.printJob.findFirstOrThrow({
        where: { kitchenTicket: { orderSessionId: accepted.orderSessionId } },
      });
      expect(job.status).toBe(PrintJobStatus.PENDING);
      await request(app.getHttpServer())
        .post(`${prefix}/online-orders/requests/cancel`)
        .send({ ...access, accessToken: '0'.repeat(64) })
        .expect(404);

      const results = await Promise.all([
        onlineOrders.cancelPublicRequest(access),
        onlineOrders.cancelPublicRequest(access),
      ]);
      expect(results).toEqual([
        { requestId: created.requestId, status: OnlineOrderStatus.CANCELLED },
        { requestId: created.requestId, status: OnlineOrderStatus.CANCELLED },
      ]);
      expect(
        await prisma.printJob.findUniqueOrThrow({ where: { id: job.id } }),
      ).toMatchObject({ status: PrintJobStatus.CANCELLED });
      expect(
        await prisma.orderSession.findUniqueOrThrow({
          where: { id: accepted.orderSessionId },
          select: {
            sessionStatus: true,
            orderItems: { select: { serveStatus: true } },
          },
        }),
      ).toMatchObject({
        sessionStatus: SessionStatus.CANCELLED,
        orderItems: [{ serveStatus: ServeStatus.CANCELLED }],
      });
      expect(
        await prisma.onlineOrderRequest.findUniqueOrThrow({
          where: { id: created.requestId },
          select: { cancellationReason: true },
        }),
      ).toMatchObject({
        cancellationReason: 'Customer cancelled before preparation.',
      });
      expect(
        await prisma.outboxEvent.count({
          where: {
            aggregateId: accepted.orderSessionId,
            eventName: 'order.session.cancelled',
          },
        }),
      ).toBe(1);

      const secondDto = createDto();
      clientRequestIds.push(secondDto.clientRequestId);
      const second = await onlineOrders.createPublicRequest(secondDto);
      const secondAccepted = await onlineOrders.accept(
        second.requestId,
        ids.employee,
      );
      const printed = await prisma.printJob.findFirstOrThrow({
        where: {
          kitchenTicket: { orderSessionId: secondAccepted.orderSessionId },
        },
      });
      await prisma.printJob.update({
        where: { id: printed.id },
        data: { status: PrintJobStatus.PRINTED, printedAt: new Date() },
      });
      await expect(
        onlineOrders.cancelPublicRequest({
          requestId: second.requestId,
          accessToken: second.accessToken,
        }),
      ).rejects.toThrow('Preparation or printing has started');
      expect(
        await prisma.onlineOrderRequest.findUniqueOrThrow({
          where: { id: second.requestId },
          select: { status: true },
        }),
      ).toEqual({ status: OnlineOrderStatus.ACCEPTED });

      const staffDto = createDto();
      clientRequestIds.push(staffDto.clientRequestId);
      const staffOrder = await onlineOrders.createPublicRequest(staffDto);
      const staffAccepted = await onlineOrders.accept(
        staffOrder.requestId,
        ids.employee,
      );
      const staffJob = await prisma.printJob.findFirstOrThrow({
        where: {
          kitchenTicket: { orderSessionId: staffAccepted.orderSessionId },
        },
      });
      await onlineOrders.cancelAccepted(
        staffOrder.requestId,
        ids.employee,
        'Requested by customer by phone.',
      );
      expect(
        await prisma.printJob.findUniqueOrThrow({ where: { id: staffJob.id } }),
      ).toMatchObject({ status: PrintJobStatus.CANCELLED });
    } finally {
      await prisma.kitchenStation.update({
        where: { id: ids.station },
        data: { printDeviceId: null },
      });
    }
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
    const expiresAt = new Date(createdAt.getTime() + 1);
    await prisma.onlineOrderRequest.update({
      where: { id: expired.requestId },
      data: { expiresAt },
    });
    const waitMs = expiresAt.getTime() - Date.now() + 5;
    if (waitMs > 5_000)
      throw new Error('Database and app clocks are out of sync.');
    await new Promise((resolve) => setTimeout(resolve, Math.max(0, waitMs)));
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

  it('collects cash and hands off every ready item exactly once', async () => {
    const fund = await prisma.fund.create({
      data: { name: `Online COD fund ${suffix}`, type: FundType.CASH },
    });
    ids.fund = fund.id;
    ids.shift = (
      await shifts.open(ids.employee, {
        fundId: fund.id,
        startingCash: '0',
      })
    ).id;

    const dto = createDto();
    clientRequestIds.push(dto.clientRequestId);
    const request = await onlineOrders.createPublicRequest(dto);
    const accepted = await onlineOrders.accept(request.requestId, ids.employee);
    const item = await prisma.orderItem.findFirstOrThrow({
      where: { orderSessionId: accepted.orderSessionId },
    });
    const pickup = {
      accessToken: request.accessToken,
      amountTendered: '60000',
      idempotencyKey: randomUUID(),
    };

    await expect(
      onlineOrders.collect(request.requestId, ids.employee, {
        ...pickup,
        accessToken: '0'.repeat(64),
      }),
    ).rejects.toThrow('Order request not found.');
    await expect(
      onlineOrders.collect(request.requestId, ids.employee, pickup),
    ).rejects.toThrow('All order items must be ready');
    await orders.updateItemStatus(item.id, ids.employee, {
      serveStatus: ServeStatus.COOKING,
    });
    await orders.updateItemStatus(item.id, ids.employee, {
      serveStatus: ServeStatus.READY,
    });
    await expect(
      orders.handoffTakeawayItem(item.id, ids.employee),
    ).rejects.toThrow('Online orders must be paid');
    const fulfillment = await onlineOrders.findFulfillment({
      page: 1,
      itemPerPage: 50,
    });
    expect(fulfillment.list).toContainEqual(
      expect.objectContaining({
        id: request.requestId,
        fulfillmentStatus: 'READY',
      }),
    );
    await expect(
      onlineOrders.collect(request.requestId, ids.employee, {
        ...pickup,
        amountTendered: '49999',
        idempotencyKey: randomUUID(),
      }),
    ).rejects.toThrow('Amount tendered is less than total amount.');
    expect(
      await prisma.invoice.count({
        where: { orderSessionId: accepted.orderSessionId },
      }),
    ).toBe(0);

    const collected = await onlineOrders.collect(
      request.requestId,
      ids.employee,
      pickup,
    );
    expect(collected).toMatchObject({
      requestId: request.requestId,
      totalAmount: '50000',
      amountTendered: '60000',
      changeAmount: '10000',
      collectedItemIds: [item.id],
    });
    expect(
      await onlineOrders.collect(request.requestId, ids.employee, pickup),
    ).toEqual(collected);
    await expect(
      onlineOrders.collect(request.requestId, ids.employee, {
        ...pickup,
        idempotencyKey: randomUUID(),
      }),
    ).rejects.toThrow('Online order is not available for pickup.');
    expect(
      await prisma.invoice.count({
        where: { orderSessionId: accepted.orderSessionId },
      }),
    ).toBe(1);
    expect(
      await prisma.cashTransaction.count({
        where: { invoiceId: collected.invoiceId },
      }),
    ).toBe(1);
    expect(
      (await prisma.orderItem.findUniqueOrThrow({ where: { id: item.id } }))
        .serveStatus,
    ).toBe(ServeStatus.SERVED);
    expect(
      (
        await prisma.orderSession.findUniqueOrThrow({
          where: { id: accepted.orderSessionId },
        })
      ).sessionStatus,
    ).toBe(SessionStatus.COMPLETED);
    expect(
      await onlineOrders.trackPublicRequest({
        requestId: request.requestId,
        accessToken: request.accessToken,
      }),
    ).toMatchObject({ fulfillmentStatus: 'COLLECTED', isPaid: true });
    expect(
      (await onlineOrders.findFulfillment({ page: 1, itemPerPage: 50 })).list,
    ).not.toContainEqual(expect.objectContaining({ id: request.requestId }));
  });

  it('cancels an accepted unpaid order with a reason', async () => {
    const dto = createDto();
    clientRequestIds.push(dto.clientRequestId);
    const request = await onlineOrders.createPublicRequest(dto);
    const accepted = await onlineOrders.accept(request.requestId, ids.employee);
    const item = await prisma.orderItem.findFirstOrThrow({
      where: { orderSessionId: accepted.orderSessionId },
    });
    await orders.updateItemStatus(item.id, ids.employee, {
      serveStatus: ServeStatus.COOKING,
    });
    const result = await onlineOrders.cancelAccepted(
      request.requestId,
      ids.employee,
      'Customer did not arrive',
    );
    expect(result.status).toBe(OnlineOrderStatus.CANCELLED);
    expect(
      await onlineOrders.cancelAccepted(
        request.requestId,
        ids.employee,
        'Customer did not arrive',
      ),
    ).toEqual(result);
    expect(
      await onlineOrders.trackPublicRequest({
        requestId: request.requestId,
        accessToken: request.accessToken,
      }),
    ).toMatchObject({
      status: OnlineOrderStatus.CANCELLED,
      cancellationReason: 'Customer did not arrive',
    });
    expect(
      (
        await prisma.orderSession.findUniqueOrThrow({
          where: { id: accepted.orderSessionId },
        })
      ).sessionStatus,
    ).toBe(SessionStatus.CANCELLED);
    expect(
      (await prisma.orderItem.findUniqueOrThrow({ where: { id: item.id } }))
        .serveStatus,
    ).toBe(ServeStatus.CANCELLED);
    expect(
      await prisma.invoice.count({
        where: { orderSessionId: accepted.orderSessionId },
      }),
    ).toBe(0);
    await expect(
      onlineOrders.collect(request.requestId, ids.employee, {
        accessToken: request.accessToken,
        amountTendered: '50000',
        idempotencyKey: randomUUID(),
      }),
    ).rejects.toThrow('Online order is not available for pickup.');
  });

  it('allows only one concurrent cash collection', async () => {
    const dto = createDto();
    clientRequestIds.push(dto.clientRequestId);
    const request = await onlineOrders.createPublicRequest(dto);
    const accepted = await onlineOrders.accept(request.requestId, ids.employee);
    const item = await prisma.orderItem.findFirstOrThrow({
      where: { orderSessionId: accepted.orderSessionId },
    });
    await orders.updateItemStatus(item.id, ids.employee, {
      serveStatus: ServeStatus.COOKING,
    });
    await orders.updateItemStatus(item.id, ids.employee, {
      serveStatus: ServeStatus.READY,
    });

    const attempts = await Promise.allSettled([
      onlineOrders.collect(request.requestId, ids.employee, {
        accessToken: request.accessToken,
        amountTendered: '50000',
        idempotencyKey: randomUUID(),
      }),
      onlineOrders.collect(request.requestId, ids.employee, {
        accessToken: request.accessToken,
        amountTendered: '50000',
        idempotencyKey: randomUUID(),
      }),
    ]);
    expect(
      attempts.filter((attempt) => attempt.status === 'fulfilled'),
    ).toHaveLength(1);
    expect(
      attempts.filter((attempt) => attempt.status === 'rejected'),
    ).toHaveLength(1);
    expect(
      await prisma.invoice.count({
        where: { orderSessionId: accepted.orderSessionId },
      }),
    ).toBe(1);
    expect(
      await prisma.cashTransaction.count({
        where: { invoice: { orderSessionId: accepted.orderSessionId } },
      }),
    ).toBe(1);
  });

  it('reports the online-order funnel and receipts by request cohort', async () => {
    const period = {
      from: new Date(Date.now() - 60_000),
      to: new Date(Date.now() + 60_000),
      timeZone: 'Asia/Ho_Chi_Minh',
    };
    const before = (await reports.getOnlineOrderJourney(period)).summary;
    const kitchenBefore = (
      await reports.getKitchenSla({ ...period, stationId: ids.station })
    ).stations[0];

    const paidDto = createDto();
    clientRequestIds.push(paidDto.clientRequestId);
    const paidRequest = await onlineOrders.createPublicRequest(paidDto);
    const accepted = await onlineOrders.accept(
      paidRequest.requestId,
      ids.employee,
    );
    const item = await prisma.orderItem.findFirstOrThrow({
      where: { orderSessionId: accepted.orderSessionId },
    });
    await orders.updateItemStatus(item.id, ids.employee, {
      serveStatus: ServeStatus.COOKING,
    });
    await orders.updateItemStatus(item.id, ids.employee, {
      serveStatus: ServeStatus.READY,
    });
    await onlineOrders.collect(paidRequest.requestId, ids.employee, {
      accessToken: paidRequest.accessToken,
      amountTendered: '50000',
      idempotencyKey: randomUUID(),
    });

    const cancelledDto = createDto();
    clientRequestIds.push(cancelledDto.clientRequestId);
    const cancelledRequest =
      await onlineOrders.createPublicRequest(cancelledDto);
    await onlineOrders.accept(cancelledRequest.requestId, ids.employee);
    await onlineOrders.cancelAccepted(
      cancelledRequest.requestId,
      ids.employee,
      'Customer cancelled',
    );

    const readyCancelledDto = createDto();
    clientRequestIds.push(readyCancelledDto.clientRequestId);
    const readyCancelledRequest =
      await onlineOrders.createPublicRequest(readyCancelledDto);
    const readyCancelledSession = await onlineOrders.accept(
      readyCancelledRequest.requestId,
      ids.employee,
    );
    const readyCancelledItem = await prisma.orderItem.findFirstOrThrow({
      where: { orderSessionId: readyCancelledSession.orderSessionId },
    });
    await orders.updateItemStatus(readyCancelledItem.id, ids.employee, {
      serveStatus: ServeStatus.COOKING,
    });
    await orders.updateItemStatus(readyCancelledItem.id, ids.employee, {
      serveStatus: ServeStatus.READY,
    });
    await onlineOrders.cancelAccepted(
      readyCancelledRequest.requestId,
      ids.employee,
      'Customer did not collect',
    );

    const rejectedDto = createDto();
    clientRequestIds.push(rejectedDto.clientRequestId);
    const rejectedRequest = await onlineOrders.createPublicRequest(rejectedDto);
    await onlineOrders.reject(
      rejectedRequest.requestId,
      ids.employee,
      'Unavailable today',
    );

    const result = await reports.getOnlineOrderJourney(period);
    const after = result.summary;
    expect(after.submittedCount - before.submittedCount).toBe(4);
    expect(after.acceptedCount - before.acceptedCount).toBe(3);
    expect(after.rejectedCount - before.rejectedCount).toBe(1);
    expect(
      after.cancelledAfterAcceptanceCount -
        before.cancelledAfterAcceptanceCount,
    ).toBe(2);
    expect(after.readyCount - before.readyCount).toBe(2);
    expect(after.paidCount - before.paidCount).toBe(1);
    expect(after.collectedCount - before.collectedCount).toBe(1);
    expect(
      new Prisma.Decimal(after.quotedDemand)
        .minus(before.quotedDemand)
        .equals(200000),
    ).toBe(true);
    expect(
      new Prisma.Decimal(after.netReceipts)
        .minus(before.netReceipts)
        .equals(50000),
    ).toBe(true);
    expect(
      new Prisma.Decimal(after.collectedNetReceipts)
        .minus(before.collectedNetReceipts)
        .equals(50000),
    ).toBe(true);
    expect(result.trend.length).toBeGreaterThan(0);
    expect(result.period.cohort).toBe('requestCreatedAt');
    const kitchenAfter = (
      await reports.getKitchenSla({ ...period, stationId: ids.station })
    ).stations[0];
    expect(kitchenAfter.ticketCount - kitchenBefore.ticketCount).toBe(3);
    expect(kitchenAfter.completedCount - kitchenBefore.completedCount).toBe(1);
  });

  it('limits accepted scheduled pickups and flags overdue orders without auto-cancelling', async () => {
    const date = vietnamDate(new Date(Date.now() + 5 * 24 * 60 * 60 * 1000));
    const available = await onlineOrders.getPickupSlots(date);
    expect(available.enabled).toBe(true);
    const publicSlots = await request(app.getHttpServer())
      .get(`${prefix}/online-orders/pickup-slots`)
      .query({ date })
      .expect(200);
    expect(publicSlots.headers['cache-control']).toBe('no-store');
    expect(publicSlots.body.data.slots).toEqual(available.slots);
    await request(app.getHttpServer())
      .get(`${prefix}/online-orders/pickup-slots`)
      .query({ date: '2026-02-30' })
      .expect(400);
    const slot = available.slots.find((entry) => entry.remaining === 4);
    expect(slot).toBeDefined();
    const pickupAt = new Date(slot!.pickupAt);
    const remaining = async () =>
      (await onlineOrders.getPickupSlots(date)).slots.find(
        (entry) => entry.pickupAt === slot!.pickupAt,
      )!.remaining;
    const requests: Awaited<
      ReturnType<OnlineOrdersService['createPublicRequest']>
    >[] = [];
    for (let index = 0; index < 5; index++) {
      const dto = { ...createDto(), pickupAt };
      clientRequestIds.push(dto.clientRequestId);
      requests.push(await onlineOrders.createPublicRequest(dto));
    }
    for (const entry of requests.slice(0, 3)) {
      await onlineOrders.accept(entry.requestId, ids.employee);
    }
    const race = await Promise.allSettled(
      requests
        .slice(3)
        .map((entry) => onlineOrders.accept(entry.requestId, ids.employee)),
    );
    expect(race.filter((result) => result.status === 'fulfilled')).toHaveLength(
      1,
    );
    expect(race.filter((result) => result.status === 'rejected')).toHaveLength(
      1,
    );
    expect(await remaining()).toBe(0);

    await onlineOrders.cancelAccepted(
      requests[0].requestId,
      ids.employee,
      'Customer cancelled',
    );
    expect(await remaining()).toBe(1);
    const rejectedIndex = race.findIndex(
      (result) => result.status === 'rejected',
    );
    await onlineOrders.accept(
      requests[rejectedIndex + 3].requestId,
      ids.employee,
    );
    expect(await remaining()).toBe(0);

    await prisma.onlineOrderRequest.update({
      where: { id: requests[1].requestId },
      data: {
        createdAt: new Date(Date.now() - 2 * 60 * 60 * 1000),
        pickupAt: new Date(Date.now() - 60 * 60 * 1000),
      },
    });
    const overdue = await onlineOrders.findFulfillment({
      page: 1,
      itemPerPage: 50,
      overdueOnly: true,
    });
    expect(overdue.list).toContainEqual(
      expect.objectContaining({
        id: requests[1].requestId,
        isOverdue: true,
      }),
    );
    expect(
      (
        await prisma.onlineOrderRequest.findUniqueOrThrow({
          where: { id: requests[1].requestId },
        })
      ).status,
    ).toBe(OnlineOrderStatus.ACCEPTED);
  });

  it('records no-show only after the scheduled and kitchen-ready grace periods', async () => {
    const date = vietnamDate(new Date(Date.now() + 24 * 60 * 60 * 1000));
    const slots = await onlineOrders.getPickupSlots(date);
    const slot = slots.slots.find((entry) => entry.remaining > 0);
    expect(slot).toBeDefined();
    const dto = { ...createDto(), pickupAt: new Date(slot!.pickupAt) };
    clientRequestIds.push(dto.clientRequestId);
    const created = await onlineOrders.createPublicRequest(dto);
    const accepted = await onlineOrders.accept(created.requestId, ids.employee);
    const item = await prisma.orderItem.findFirstOrThrow({
      where: { orderSessionId: accepted.orderSessionId },
    });
    await orders.updateItemStatus(item.id, ids.employee, {
      serveStatus: ServeStatus.COOKING,
    });
    await orders.updateItemStatus(item.id, ids.employee, {
      serveStatus: ServeStatus.READY,
    });
    await expect(
      onlineOrders.markNoShow(created.requestId, ids.employee),
    ).rejects.toThrow('No-show requires a prepared order');

    const now = Date.now();
    await prisma.onlineOrderRequest.update({
      where: { id: created.requestId },
      data: {
        createdAt: new Date(now - 2 * 60 * 60_000),
        pickupAt: new Date(now - 60 * 60_000),
      },
    });
    await expect(
      onlineOrders.markNoShow(created.requestId, ids.employee),
    ).rejects.toThrow('No-show requires a prepared order');
    await prisma.orderItem.update({
      where: { id: item.id },
      data: { readyAt: new Date(now - 30 * 60_000) },
    });
    expect(
      (await onlineOrders.findOne(created.requestId)).isNoShowEligible,
    ).toBe(true);

    const period = {
      from: new Date(now - 3 * 60 * 60_000),
      to: new Date(now + 60 * 60_000),
      timeZone: 'Asia/Ho_Chi_Minh',
    };
    const before = (await reports.getOnlineOrderJourney(period)).summary;
    const noShow = await onlineOrders.markNoShow(
      created.requestId,
      ids.employee,
    );
    expect(noShow.noShowAt).toBeInstanceOf(Date);
    expect(
      await onlineOrders.markNoShow(created.requestId, ids.employee),
    ).toEqual(noShow);
    expect(
      await onlineOrders.trackPublicRequest({
        requestId: created.requestId,
        accessToken: created.accessToken,
      }),
    ).toMatchObject({
      status: OnlineOrderStatus.CANCELLED,
      noShowAt: noShow.noShowAt,
    });
    expect(
      (
        await prisma.orderSession.findUniqueOrThrow({
          where: { id: accepted.orderSessionId },
        })
      ).sessionStatus,
    ).toBe(SessionStatus.CANCELLED);
    const after = (await reports.getOnlineOrderJourney(period)).summary;
    expect(after.noShowCount - before.noShowCount).toBe(1);
    expect(after.scheduledAcceptedCount).toBe(before.scheduledAcceptedCount);
  });

  it('previews a prior basket at current prices and enforces the confirmed maximum', async () => {
    const sourceDto = createDto();
    clientRequestIds.push(sourceDto.clientRequestId);
    const source = await request(app.getHttpServer())
      .post(`${prefix}/online-orders/requests`)
      .send(sourceDto)
      .expect(201);
    const sourceData = source.body.data as {
      requestId: string;
      accessToken: string;
      reorderToken: string;
    };
    expect(sourceData.reorderToken).toMatch(/^[0-9a-f]{64}$/);
    const replay = await request(app.getHttpServer())
      .post(`${prefix}/online-orders/requests`)
      .send(sourceDto)
      .expect(201);
    expect(replay.body.data.reorderToken).toBe(sourceData.reorderToken);

    const preview = await request(app.getHttpServer())
      .post(`${prefix}/online-orders/requests/reorder-template`)
      .send({
        requestId: sourceData.requestId,
        reorderToken: sourceData.reorderToken,
      })
      .expect(200);
    expect(preview.body.data).toMatchObject({
      quote: {
        previousSubtotal: '50000.00',
        currentSubtotal: '50000.00',
        canSubmit: true,
      },
    });
    expect(preview.body.data).not.toHaveProperty('phoneNumber');
    expect(preview.body.data).not.toHaveProperty('pickupName');
    await request(app.getHttpServer())
      .post(`${prefix}/online-orders/requests/reorder-template`)
      .send({ requestId: sourceData.requestId, reorderToken: '0'.repeat(64) })
      .expect(404);

    await prisma.menuItem.update({
      where: { id: ids.menuItem },
      data: { price: 30_000 },
    });
    try {
      const repriced = await request(app.getHttpServer())
        .post(`${prefix}/online-orders/requests/reorder-template`)
        .send({
          requestId: sourceData.requestId,
          reorderToken: sourceData.reorderToken,
        })
        .expect(200);
      expect(repriced.body.data.quote).toMatchObject({
        currentSubtotal: '60000.00',
        canSubmit: true,
        lines: [expect.objectContaining({ currentUnitPrice: '30000.00' })],
      });
      const newDto = {
        clientRequestId: randomUUID(),
        pickupName: 'Repeat pickup',
        phoneNumber: '0901234567',
        items: repriced.body.data.items,
        maxSubtotal: '50000.00',
      };
      clientRequestIds.push(newDto.clientRequestId);
      await request(app.getHttpServer())
        .post(`${prefix}/online-orders/requests`)
        .send(newDto)
        .expect(409);
      expect(
        await prisma.onlineOrderRequest.count({
          where: { clientRequestId: newDto.clientRequestId },
        }),
      ).toBe(0);
      const confirmed = await request(app.getHttpServer())
        .post(`${prefix}/online-orders/requests`)
        .send({ ...newDto, maxSubtotal: '60000.00' })
        .expect(201);
      expect(confirmed.body.data.quotedSubtotal).toBe(60_000);
      const confirmedReplay = await request(app.getHttpServer())
        .post(`${prefix}/online-orders/requests`)
        .send({ ...newDto, maxSubtotal: '60000' })
        .expect(201);
      expect(confirmedReplay.body.data.requestId).toBe(
        confirmed.body.data.requestId,
      );

      await prisma.menuItem.update({
        where: { id: ids.menuItem },
        data: { isAvailable: false },
      });
      const unavailable = await request(app.getHttpServer())
        .post(`${prefix}/online-orders/requests/reorder-template`)
        .send({
          requestId: sourceData.requestId,
          reorderToken: sourceData.reorderToken,
        })
        .expect(200);
      expect(unavailable.body.data.quote).toMatchObject({
        currentSubtotal: null,
        canSubmit: false,
        lines: [expect.objectContaining({ reason: 'ITEM_UNAVAILABLE' })],
      });
    } finally {
      await prisma.menuItem.update({
        where: { id: ids.menuItem },
        data: { price: 25_000, isAvailable: true },
      });
    }
  });

  it('keeps the long-lived reorder key separate from order access and supports revocation', async () => {
    const dto = {
      ...createDto(),
      items: [{ menuItemId: ids.menuItem, quantity: 1 }],
    };
    clientRequestIds.push(dto.clientRequestId);
    const source = await onlineOrders.createPublicRequest(dto);
    const access = {
      requestId: source.requestId,
      accessToken: source.accessToken,
    };
    await prisma.onlineOrderRequest.update({
      where: { id: source.requestId },
      data: { reorderNonce: null },
    });
    const [first, second] = await Promise.all([
      onlineOrders.issueReorderKey(access),
      onlineOrders.issueReorderKey(access),
    ]);
    expect(first.reorderToken).toBe(second.reorderToken);
    const oldCreatedAt = new Date(Date.now() - 90 * 24 * 60 * 60_000);
    await prisma.onlineOrderRequest.update({
      where: { id: source.requestId },
      data: { createdAt: oldCreatedAt },
    });
    await request(app.getHttpServer())
      .post(`${prefix}/online-orders/requests/reorder-template`)
      .send(access)
      .expect(404);
    const longLived = await request(app.getHttpServer())
      .post(`${prefix}/online-orders/requests/reorder-template`)
      .send({ requestId: source.requestId, reorderToken: first.reorderToken })
      .expect(200);
    expect(longLived.body.data.items).toEqual([
      { menuItemId: ids.menuItem, quantity: 1, optionIds: [] },
    ]);
    expect(longLived.body.data).not.toHaveProperty('phoneNumber');
    expect(
      (await onlineOrders.createPublicRequest(dto)).reorderToken,
    ).toBeNull();

    await prisma.onlineOrderRequest.update({
      where: { id: source.requestId },
      data: { createdAt: new Date(Date.now() - 181 * 24 * 60 * 60_000) },
    });
    await request(app.getHttpServer())
      .post(`${prefix}/online-orders/requests/reorder-template`)
      .send({ requestId: source.requestId, reorderToken: first.reorderToken })
      .expect(404);
    await prisma.onlineOrderRequest.update({
      where: { id: source.requestId },
      data: { createdAt: oldCreatedAt },
    });
    await request(app.getHttpServer())
      .post(`${prefix}/online-orders/requests/reorder-key/revoke`)
      .send({ requestId: source.requestId, reorderToken: first.reorderToken })
      .expect(200);
    await request(app.getHttpServer())
      .post(`${prefix}/online-orders/requests/reorder-template`)
      .send({ requestId: source.requestId, reorderToken: first.reorderToken })
      .expect(404);
  });

  it('quotes distinct options per line and consumes the accepted recipe snapshot', async () => {
    ids.unit = (
      await prisma.unit.create({ data: { name: `ml-${suffix}` } })
    ).id;
    ids.inventoryCategory = (
      await prisma.inventoryCategory.create({
        data: { name: `Option ingredients ${suffix}` },
      })
    ).id;
    ids.inventoryItem = (
      await prisma.inventoryItem.create({
        data: {
          name: `Milk ${suffix}`,
          categoryId: ids.inventoryCategory,
          unitId: ids.unit,
          stock: 10,
        },
      })
    ).id;
    await prisma.menuItemIngredient.create({
      data: {
        menuItemId: ids.menuItem,
        inventoryItemId: ids.inventoryItem,
        quantity: '0.1',
      },
    });
    const optionDto = {
      groups: [
        {
          name: 'Size',
          minSelected: 1,
          maxSelected: 1,
          options: [
            {
              name: 'Medium',
              priceDelta: 2000,
              ingredients: [
                { inventoryItemId: ids.inventoryItem, quantity: '0.02' },
              ],
            },
            {
              name: 'Large',
              priceDelta: 5000,
              ingredients: [
                { inventoryItemId: ids.inventoryItem, quantity: '0.05' },
              ],
            },
          ],
        },
      ],
    };
    const configured = await menu.replaceItemOptions(
      ids.menuItem,
      ids.employee,
      optionDto,
    );
    const [medium, large] = configured.optionGroups[0].options;
    const publicMenu = await request(app.getHttpServer())
      .get(`${prefix}/menu/public/items`)
      .expect(200);
    expect(publicMenu.body.data.list).toContainEqual(
      expect.objectContaining({
        id: ids.menuItem,
        optionGroups: [expect.objectContaining({ name: 'Size' })],
      }),
    );

    const dto = {
      ...createDto(),
      items: [
        { menuItemId: ids.menuItem, quantity: 2, optionIds: [large.id] },
        { menuItemId: ids.menuItem, quantity: 1, optionIds: [medium.id] },
      ],
    };
    clientRequestIds.push(dto.clientRequestId);
    const quoted = await onlineOrders.createPublicRequest(dto);
    const repeated = await menu.replaceItemOptions(
      ids.menuItem,
      ids.employee,
      optionDto,
    );
    expect(repeated.optionGroups[0].options.map((option) => option.id)).toEqual(
      [medium.id, large.id],
    );
    expect(
      await prisma.actionLog.count({
        where: {
          employeeId: ids.employee,
          actionType: 'MENU_OPTIONS_REPLACED',
        },
      }),
    ).toBe(1);
    expect(quoted.quotedSubtotal.equals(87000)).toBe(true);
    expect(quoted.items.map((item) => item.quotedUnitPrice.toString())).toEqual(
      ['30000', '27000'],
    );
    const accepted = await onlineOrders.accept(quoted.requestId, ids.employee);
    const savedItems = await prisma.orderItem.findMany({
      where: { orderSessionId: accepted.orderSessionId },
      include: { recipeIngredients: true, kitchenTicketItem: true },
    });
    expect(savedItems).toHaveLength(2);
    const largeItem = savedItems.find((item) => item.priceAtTime.equals(30000));
    expect(largeItem).toBeDefined();
    expect(largeItem!.selectedOptions).toEqual([
      expect.objectContaining({ id: large.id, name: 'Large' }),
    ]);
    expect(largeItem!.kitchenTicketItem?.selectedOptions).toEqual(
      largeItem!.selectedOptions,
    );
    expect(largeItem!.recipeIngredients[0].quantityPerItem.equals('0.15')).toBe(
      true,
    );

    await prisma.menuItemIngredient.update({
      where: {
        menuItemId_inventoryItemId: {
          menuItemId: ids.menuItem,
          inventoryItemId: ids.inventoryItem,
        },
      },
      data: { quantity: '0.5' },
    });
    await orders.updateItemStatus(largeItem!.id, ids.employee, {
      serveStatus: ServeStatus.COOKING,
    });
    const stock = await prisma.inventoryItem.findUniqueOrThrow({
      where: { id: ids.inventoryItem },
    });
    expect(stock.stock.equals('9.7')).toBe(true);
    await onlineOrders.cancelAccepted(
      quoted.requestId,
      ids.employee,
      'Customer cancelled before collection',
    );
    const waste = await prisma.inventoryWaste.findFirstOrThrow({
      where: { orderItemId: largeItem!.id },
    });
    expect(waste.quantity.equals('0.3')).toBe(true);
    expect(
      (
        await prisma.inventoryItem.findUniqueOrThrow({
          where: { id: ids.inventoryItem },
        })
      ).stock.equals('9.7'),
    ).toBe(true);

    const changedDto = {
      ...createDto(),
      items: [{ menuItemId: ids.menuItem, quantity: 1, optionIds: [large.id] }],
    };
    clientRequestIds.push(changedDto.clientRequestId);
    const stale = await onlineOrders.createPublicRequest(changedDto);
    await prisma.menuItemOption.update({
      where: { id: large.id },
      data: { priceDelta: 6000 },
    });
    await expect(
      onlineOrders.accept(stale.requestId, ids.employee),
    ).rejects.toThrow(
      'Menu price or options changed since the order was placed.',
    );
    const repriced = await onlineOrders.reorderTemplate({
      requestId: stale.requestId,
      accessToken: stale.accessToken,
    });
    expect(repriced.quote).toMatchObject({
      previousSubtotal: '30000.00',
      currentSubtotal: '31000.00',
      canSubmit: true,
    });
    await prisma.menuItemOption.delete({ where: { id: large.id } });
    const unavailable = await onlineOrders.reorderTemplate({
      requestId: stale.requestId,
      accessToken: stale.accessToken,
    });
    expect(unavailable.quote).toMatchObject({
      currentSubtotal: null,
      canSubmit: false,
      lines: [expect.objectContaining({ reason: 'SELECTION_UNAVAILABLE' })],
    });
  });
});
