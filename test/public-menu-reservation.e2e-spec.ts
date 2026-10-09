import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { ForbiddenException, INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { NestExpressApplication } from '@nestjs/platform-express';
import { ThrottlerGuard } from '@nestjs/throttler';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from '../src/app/app.module';
import { TurnstileService } from '../src/app/auth/turnstile.service';
import { ReservationsService } from '../src/app/reservations/reservations.service';
import { PrismaService } from '../src/common/prisma/prisma.service';
import { initApp } from '../src/init';

describe('Public menu and reservation request (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let reservations: ReservationsService;
  let turnstile: TurnstileService;
  let throttleSpy: jest.SpyInstance;
  let prefix: string;
  let positionId: string;
  let employeeId: string;
  let tableId: string;
  let categoryId: string;
  const publicRequestIds: string[] = [];
  const tableIds: string[] = [];
  const suffix = randomUUID();

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
    reservations = module.get(ReservationsService);
    turnstile = module.get(TurnstileService);
    prefix = module.get(ConfigService).get<string>('APP_PREFIX', '/api/v1');
    await app.init();

    const position = await prisma.position.create({
      data: { name: `Public booking position ${suffix}`, salary: 0 },
    });
    positionId = position.id;
    const employee = await prisma.employee.create({
      data: {
        email: `booking-${suffix}@example.com`,
        username: `booking-${suffix}`,
        fullName: 'Booking employee',
        password: 'test-only',
        positionId,
      },
    });
    employeeId = employee.id;
    const category = await prisma.menuCategory.create({
      data: { name: `Public category ${suffix}` },
    });
    categoryId = category.id;
    await prisma.menuItem.createMany({
      data: [
        { name: `Visible ${suffix}`, price: '30000', categoryId },
        {
          name: `Hidden ${suffix}`,
          price: '30000',
          categoryId,
          isAvailable: false,
        },
      ],
    });
  });

  beforeEach(async () => {
    const table = await prisma.diningTable.create({
      data: { name: `Booking table ${randomUUID()}` },
    });
    tableId = table.id;
    tableIds.push(tableId);
  });

  afterAll(async () => {
    try {
      if (employeeId) {
        await prisma.reservationRequest.deleteMany({
          where: { id: { in: publicRequestIds } },
        });
        await prisma.reservation.deleteMany({ where: { employeeId } });
        await prisma.$transaction(async (tx) => {
          await tx.$executeRawUnsafe(
            "SET LOCAL app.allow_audit_log_mutation = 'on'",
          );
          await tx.actionLog.deleteMany({ where: { employeeId } });
        });
      }
      if (categoryId) {
        await prisma.menuItem.deleteMany({ where: { categoryId } });
        await prisma.menuCategory.deleteMany({ where: { id: categoryId } });
      }
      if (tableIds.length)
        await prisma.diningTable.deleteMany({
          where: { id: { in: tableIds } },
        });
      if (employeeId)
        await prisma.employee.deleteMany({ where: { id: employeeId } });
      if (positionId)
        await prisma.position.deleteMany({ where: { id: positionId } });
    } finally {
      await app?.close();
      throttleSpy?.mockRestore();
    }
  });

  it('allows only one concurrent edit for the same reservation revision', async () => {
    const startsAt = new Date(Date.now() + 10 * 24 * 60 * 60 * 1000);
    const created = await reservations.create(employeeId, {
      phoneNumber: '0900000099',
      tableId,
      guestCount: 2,
      startsAt,
      endsAt: new Date(startsAt.getTime() + 60 * 60 * 1000),
    });
    const results = await Promise.allSettled([
      reservations.update(created.id, employeeId, {
        notes: 'Editor A',
        expectedUpdatedAt: created.updatedAt,
      }),
      reservations.update(created.id, employeeId, {
        notes: 'Editor B',
        expectedUpdatedAt: created.updatedAt,
      }),
    ]);
    expect(
      results.filter((result) => result.status === 'fulfilled'),
    ).toHaveLength(1);
    expect(
      results.filter((result) => result.status === 'rejected'),
    ).toHaveLength(1);
    const persisted = await prisma.reservation.findUniqueOrThrow({
      where: { id: created.id },
    });
    expect(persisted.updatedAt.getTime()).toBeGreaterThan(
      created.updatedAt.getTime(),
    );
    expect(['Editor A', 'Editor B']).toContain(persisted.notes);
    expect(
      await prisma.actionLog.count({
        where: { employeeId, actionType: 'RESERVATION_UPDATED' },
      }),
    ).toBe(1);
  });

  it('shows only public sale fields for available items', async () => {
    const response = await request(app.getHttpServer())
      .get(`${prefix}/menu/public/items`)
      .query({ categoryId, page: 1, itemPerPage: 20 })
      .expect(200);
    expect(response.body.data.list).toHaveLength(1);
    expect(response.body.data.list[0]).toMatchObject({
      name: `Visible ${suffix}`,
    });
    expect(response.body.data.list[0]).not.toHaveProperty('ingredients');
    expect(response.body.data.list[0]).not.toHaveProperty('kitchenStationId');
  });

  it('requires human verification before creating a public reservation', async () => {
    const startsAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
    const dto = {
      customerName: 'Verified guest',
      phoneNumber: '0900000099',
      startsAt: startsAt.toISOString(),
      endsAt: new Date(startsAt.getTime() + 60 * 60 * 1000).toISOString(),
      guestCount: 2,
    };
    const verify = jest
      .spyOn(turnstile, 'verify')
      .mockImplementation((token, _ip, action) =>
        token === 'challenge' && action === 'reservation_request'
          ? Promise.resolve()
          : Promise.reject(new ForbiddenException()),
      );
    try {
      await request(app.getHttpServer())
        .post(`${prefix}/reservations/public/requests`)
        .send(dto)
        .expect(403);
      const created = await request(app.getHttpServer())
        .post(`${prefix}/reservations/public/requests`)
        .send({ ...dto, turnstileToken: 'challenge' })
        .expect(201);
      publicRequestIds.push(created.body.data.requestId as string);
      expect(verify).toHaveBeenCalledTimes(2);
      expect(verify).toHaveBeenCalledWith(
        'challenge',
        expect.any(String),
        'reservation_request',
      );
    } finally {
      verify.mockRestore();
    }
  });

  it('replays the same reservation without a second challenge and rejects changed details', async () => {
    const startsAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
    const dto = {
      clientRequestToken: randomBytes(32).toString('base64url'),
      customerName: 'Idempotent guest',
      phoneNumber: '0900000098',
      startsAt: startsAt.toISOString(),
      endsAt: new Date(startsAt.getTime() + 60 * 60 * 1000).toISOString(),
      guestCount: 2,
    };
    const verify = jest
      .spyOn(turnstile, 'verify')
      .mockImplementation((token, _ip, action) =>
        token === 'challenge' && action === 'reservation_request'
          ? Promise.resolve()
          : Promise.reject(new ForbiddenException()),
      );
    try {
      const created = await request(app.getHttpServer())
        .post(`${prefix}/reservations/public/requests`)
        .send({ ...dto, turnstileToken: 'challenge' })
        .expect(201);
      publicRequestIds.push(created.body.data.requestId as string);
      const replay = await request(app.getHttpServer())
        .post(`${prefix}/reservations/public/requests`)
        .send(dto)
        .expect(201);
      expect(replay.body.data).toEqual(created.body.data);
      await request(app.getHttpServer())
        .post(`${prefix}/reservations/public/requests`)
        .send({ ...dto, guestCount: 3 })
        .expect(409);
      expect(verify).toHaveBeenCalledTimes(1);
    } finally {
      verify.mockRestore();
    }
  });

  it('creates only one reservation request for concurrent retries', async () => {
    const startsAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
    const dto = {
      clientRequestToken: randomBytes(32).toString('base64url'),
      customerName: 'Concurrent guest',
      phoneNumber: '0900000097',
      startsAt: startsAt.toISOString(),
      endsAt: new Date(startsAt.getTime() + 60 * 60 * 1000).toISOString(),
      guestCount: 2,
    };
    const verify = jest
      .spyOn(turnstile, 'verify')
      .mockImplementation((token, _ip, action) =>
        token?.startsWith('challenge-') && action === 'reservation_request'
          ? Promise.resolve()
          : Promise.reject(new ForbiddenException()),
      );
    try {
      const [first, second] = await Promise.all([
        request(app.getHttpServer())
          .post(`${prefix}/reservations/public/requests`)
          .send({ ...dto, turnstileToken: 'challenge-1' }),
        request(app.getHttpServer())
          .post(`${prefix}/reservations/public/requests`)
          .send({ ...dto, turnstileToken: 'challenge-2' }),
      ]);
      expect(first.status).toBe(201);
      expect(second.status).toBe(201);
      expect(first.body.data).toEqual(second.body.data);
      publicRequestIds.push(first.body.data.requestId as string);
      expect(
        await prisma.reservationRequest.count({
          where: {
            accessTokenHash: createHash('sha256')
              .update(dto.clientRequestToken)
              .digest('hex'),
          },
        }),
      ).toBe(1);
    } finally {
      verify.mockRestore();
    }
  });

  it('keeps public requests unconfirmed until a staff member assigns a table', async () => {
    expect(await prisma.reservation.count({ where: { tableId } })).toBe(0);
    const startsAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
    const endsAt = new Date(startsAt.getTime() + 60 * 60 * 1000);
    const response = await request(app.getHttpServer())
      .post(`${prefix}/reservations/public/requests`)
      .send({
        customerName: 'Guest',
        phoneNumber: '0900000000',
        startsAt: startsAt.toISOString(),
        endsAt: endsAt.toISOString(),
        guestCount: 2,
      })
      .expect(201);
    const requestId = response.body.data.requestId as string;
    const accessToken = response.body.data.accessToken as string;
    publicRequestIds.push(requestId);
    expect(response.body.data).toEqual({
      requestId,
      status: 'PENDING',
      accessToken: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
    });
    expect(response.headers['cache-control']).toBe('no-store');
    expect(await prisma.reservation.count({ where: { tableId } })).toBe(0);

    const pending = await request(app.getHttpServer())
      .post(`${prefix}/reservations/public/requests/status`)
      .send({ accessToken })
      .expect(200);
    expect(pending.headers['cache-control']).toBe('no-store');
    expect(pending.body.data).toMatchObject({
      requestId,
      status: 'PENDING',
      reservationStatus: null,
    });
    expect(pending.body.data).not.toHaveProperty('phoneNumber');
    expect(pending.body.data).not.toHaveProperty('customerName');
    await request(app.getHttpServer())
      .post(`${prefix}/reservations/public/requests/status`)
      .send({ accessToken: 'A'.repeat(43) })
      .expect(404);

    const approved = await reservations.approveRequest(requestId, employeeId, {
      tableId,
    });
    expect(approved.tableId).toBe(tableId);
    const tracked = await request(app.getHttpServer())
      .post(`${prefix}/reservations/public/requests/status`)
      .send({ accessToken })
      .expect(200);
    expect(tracked.body.data).toMatchObject({
      requestId,
      status: 'APPROVED',
      reservationStatus: 'PENDING',
    });
    await expect(
      reservations.approveRequest(requestId, employeeId, { tableId }),
    ).rejects.toThrow('Request has already been reviewed.');
    expect(await prisma.reservation.count({ where: { tableId } })).toBe(1);
  });

  it('confirms a public request only once under concurrent review', async () => {
    const startsAt = new Date(Date.now() + 48 * 60 * 60 * 1000);
    const response = await request(app.getHttpServer())
      .post(`${prefix}/reservations/public/requests`)
      .send({
        customerName: 'Another guest',
        phoneNumber: '0900000001',
        startsAt: startsAt.toISOString(),
        endsAt: new Date(startsAt.getTime() + 60 * 60 * 1000).toISOString(),
        guestCount: 2,
      })
      .expect(201);
    const requestId = response.body.data.requestId as string;
    publicRequestIds.push(requestId);

    const attempts = await Promise.allSettled([
      reservations.approveRequest(requestId, employeeId, { tableId }),
      reservations.approveRequest(requestId, employeeId, { tableId }),
    ]);
    expect(
      attempts.filter((result) => result.status === 'fulfilled'),
    ).toHaveLength(1);
    expect(
      attempts.filter((result) => result.status === 'rejected'),
    ).toHaveLength(1);
    expect(
      await prisma.reservationRequest.findUniqueOrThrow({
        where: { id: requestId },
        select: { status: true, reservationId: true },
      }),
    ).toMatchObject({ status: 'APPROVED', reservationId: expect.any(Number) });
  });

  it('lets the customer withdraw a pending request only once', async () => {
    const startsAt = new Date(Date.now() + 72 * 60 * 60 * 1000);
    const response = await request(app.getHttpServer())
      .post(`${prefix}/reservations/public/requests`)
      .send({
        customerName: 'Cancelling guest',
        phoneNumber: '0900000002',
        startsAt: startsAt.toISOString(),
        endsAt: new Date(startsAt.getTime() + 60 * 60 * 1000).toISOString(),
        guestCount: 2,
      })
      .expect(201);
    const { requestId, accessToken } = response.body.data as {
      requestId: string;
      accessToken: string;
    };
    publicRequestIds.push(requestId);

    for (let attempt = 0; attempt < 2; attempt++) {
      const cancelled = await request(app.getHttpServer())
        .post(`${prefix}/reservations/public/requests/cancel`)
        .send({ accessToken })
        .expect(200);
      expect(cancelled.body.data).toEqual({ requestId, status: 'CANCELLED' });
    }
    await expect(
      reservations.approveRequest(requestId, employeeId, { tableId }),
    ).rejects.toThrow('Request has already been reviewed.');
    expect(
      await prisma.reservationRequest.findUniqueOrThrow({
        where: { id: requestId },
        select: { reservationId: true, cancelledAt: true },
      }),
    ).toMatchObject({ reservationId: null, cancelledAt: expect.any(Date) });
  });

  it('allows only one winner when withdrawal races with staff approval', async () => {
    const startsAt = new Date(Date.now() + 96 * 60 * 60 * 1000);
    const { requestId, accessToken } = await reservations.createPublicRequest({
      customerName: 'Racing guest',
      phoneNumber: '0900000003',
      startsAt,
      endsAt: new Date(startsAt.getTime() + 60 * 60 * 1000),
      guestCount: 2,
    });
    publicRequestIds.push(requestId);

    await Promise.allSettled([
      reservations.cancelPublicRequest(accessToken),
      reservations.approveRequest(requestId, employeeId, { tableId }),
    ]);
    const record = await prisma.reservationRequest.findUniqueOrThrow({
      where: { id: requestId },
      select: { status: true, reservationId: true },
    });
    expect(
      (record.status === 'CANCELLED' && record.reservationId === null) ||
        (record.status === 'APPROVED' && record.reservationId !== null),
    ).toBe(true);
  });
});
