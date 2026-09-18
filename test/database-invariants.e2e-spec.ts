import { randomUUID } from 'node:crypto';
import { PrismaClient, ShiftStatus } from '@prisma/client';

describe('Database invariants (e2e)', () => {
  const prisma = new PrismaClient();
  const suffix = randomUUID();
  const positionName = `Invariant Position ${suffix}`;
  const tableName = `Invariant Table ${suffix}`;
  const categoryName = `Invariant Category ${suffix}`;

  let positionId: string | undefined;
  let employeeId: string | undefined;
  let tableId: string | undefined;
  let categoryId: string | undefined;

  beforeAll(async () => {
    const position = await prisma.position.create({
      data: { name: positionName, salary: 0 },
    });
    positionId = position.id;

    const employee = await prisma.employee.create({
      data: {
        email: `invariant-${suffix}@example.com`,
        username: `invariant-${suffix}`,
        fullName: 'Invariant Test Employee',
        password: 'not-used-in-invariant-tests',
        positionId,
      },
    });
    employeeId = employee.id;

    const table = await prisma.diningTable.create({
      data: { name: tableName },
    });
    tableId = table.id;

    const category = await prisma.menuCategory.create({
      data: { name: categoryName },
    });
    categoryId = category.id;
  });

  afterAll(async () => {
    try {
      if (employeeId) {
        await prisma.orderSession.deleteMany({ where: { employeeId } });
        await prisma.cashierShift.deleteMany({ where: { employeeId } });
        await prisma.employee.deleteMany({ where: { id: employeeId } });
      }
      if (tableId) {
        await prisma.diningTable.deleteMany({ where: { id: tableId } });
      }
      if (categoryId) {
        await prisma.menuItem.deleteMany({ where: { categoryId } });
        await prisma.menuCategory.deleteMany({ where: { id: categoryId } });
      }
      if (positionId) {
        await prisma.position.deleteMany({ where: { id: positionId } });
      }
    } finally {
      await prisma.$disconnect();
    }
  });

  it('rejects duplicate active names after case and whitespace normalization', async () => {
    await expect(
      prisma.position.create({
        data: { name: `  ${positionName.toUpperCase()}  `, salary: 0 },
      }),
    ).rejects.toBeDefined();

    await expect(
      prisma.diningTable.create({
        data: { name: `  ${tableName.toUpperCase()}  ` },
      }),
    ).rejects.toBeDefined();
  });

  it('allows only one concurrent active order session per table', async () => {
    const results = await Promise.allSettled([
      prisma.orderSession.create({
        data: { tableId: tableId!, employeeId: employeeId! },
      }),
      prisma.orderSession.create({
        data: { tableId: tableId!, employeeId: employeeId! },
      }),
    ]);

    expect(results.filter(({ status }) => status === 'fulfilled')).toHaveLength(
      1,
    );
    expect(results.filter(({ status }) => status === 'rejected')).toHaveLength(
      1,
    );
  });

  it('allows only one concurrent open cashier shift per employee', async () => {
    const results = await Promise.allSettled([
      prisma.cashierShift.create({
        data: { employeeId: employeeId!, startingCash: 0 },
      }),
      prisma.cashierShift.create({
        data: { employeeId: employeeId!, startingCash: 0 },
      }),
    ]);

    expect(results.filter(({ status }) => status === 'fulfilled')).toHaveLength(
      1,
    );
    expect(results.filter(({ status }) => status === 'rejected')).toHaveLength(
      1,
    );
  });

  it('rejects inconsistent closed shifts and negative menu prices', async () => {
    await expect(
      prisma.cashierShift.create({
        data: {
          employeeId: employeeId!,
          status: ShiftStatus.CLOSED,
          closedAt: new Date(),
          startingCash: 0,
        },
      }),
    ).rejects.toBeDefined();

    await expect(
      prisma.menuItem.create({
        data: {
          name: `Invalid price ${suffix}`,
          price: -1,
          categoryId: categoryId!,
        },
      }),
    ).rejects.toBeDefined();
  });
});
