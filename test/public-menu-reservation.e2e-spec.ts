import { randomUUID } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from '../src/app/app.module';
import { ReservationsService } from '../src/app/reservations/reservations.service';
import { PrismaService } from '../src/common/prisma/prisma.service';
import { initApp } from '../src/init';

describe('Public menu and reservation request (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let reservations: ReservationsService;
  let prefix: string;
  let positionId: string;
  let employeeId: string;
  let tableId: string;
  let categoryId: string;
  const publicRequestIds: string[] = [];
  const suffix = randomUUID();

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    const expressApp = module.createNestApplication<NestExpressApplication>();
    initApp(expressApp);
    app = expressApp;
    prisma = module.get(PrismaService);
    reservations = module.get(ReservationsService);
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
    const table = await prisma.diningTable.create({
      data: { name: `Booking table ${suffix}` },
    });
    tableId = table.id;
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
      if (tableId)
        await prisma.diningTable.deleteMany({ where: { id: tableId } });
      if (employeeId)
        await prisma.employee.deleteMany({ where: { id: employeeId } });
      if (positionId)
        await prisma.position.deleteMany({ where: { id: positionId } });
    } finally {
      await app?.close();
    }
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

  it('keeps public requests unconfirmed until a staff member assigns a table', async () => {
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
    publicRequestIds.push(requestId);
    expect(response.body.data).toEqual({
      requestId,
      status: 'PENDING',
    });
    expect(await prisma.reservation.count({ where: { tableId } })).toBe(0);

    const approved = await reservations.approveRequest(requestId, employeeId, {
      tableId,
    });
    expect(approved.tableId).toBe(tableId);
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
});
