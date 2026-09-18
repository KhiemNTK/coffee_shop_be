import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';

describe('Reservation database invariants (e2e)', () => {
  const prisma = new PrismaClient();
  const suffix = randomUUID();
  const startsAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
  const endsAt = new Date(startsAt.getTime() + 60 * 60 * 1000);

  let positionId: string;
  let employeeId: string;
  let tableId: string;

  beforeAll(async () => {
    const position = await prisma.position.create({
      data: { name: `Reservation Position ${suffix}`, salary: 0 },
    });
    positionId = position.id;

    const employee = await prisma.employee.create({
      data: {
        email: `reservation-${suffix}@example.com`,
        username: `reservation-${suffix}`,
        fullName: 'Reservation Test Employee',
        password: 'not-used-in-reservation-tests',
        positionId,
      },
    });
    employeeId = employee.id;

    const table = await prisma.diningTable.create({
      data: { name: `Reservation Table ${suffix}` },
    });
    tableId = table.id;
  });

  afterAll(async () => {
    try {
      await prisma.reservation.deleteMany({ where: { tableId } });
      await prisma.diningTable.deleteMany({ where: { id: tableId } });
      await prisma.employee.deleteMany({ where: { id: employeeId } });
      await prisma.position.deleteMany({ where: { id: positionId } });
    } finally {
      await prisma.$disconnect();
    }
  });

  it('allows only one concurrent active reservation for an overlapping slot', async () => {
    const createReservation = () =>
      prisma.reservation.create({
        data: {
          phoneNumber: '0900000000',
          startsAt,
          endsAt,
          guestCount: 2,
          tableId,
          employeeId,
        },
      });

    const results = await Promise.allSettled([
      createReservation(),
      createReservation(),
    ]);

    expect(results.filter(({ status }) => status === 'fulfilled')).toHaveLength(
      1,
    );
    expect(results.filter(({ status }) => status === 'rejected')).toHaveLength(
      1,
    );
  });

  it('allows an adjacent half-open reservation slot', async () => {
    await expect(
      prisma.reservation.create({
        data: {
          phoneNumber: '0900000001',
          startsAt: endsAt,
          endsAt: new Date(endsAt.getTime() + 60 * 60 * 1000),
          guestCount: 2,
          tableId,
          employeeId,
        },
      }),
    ).resolves.toBeDefined();
  });

  it('rejects an invalid time range at the database boundary', async () => {
    await expect(
      prisma.reservation.create({
        data: {
          phoneNumber: '0900000002',
          startsAt: endsAt,
          endsAt: startsAt,
          guestCount: 2,
          tableId,
          employeeId,
        },
      }),
    ).rejects.toBeDefined();
  });
});
