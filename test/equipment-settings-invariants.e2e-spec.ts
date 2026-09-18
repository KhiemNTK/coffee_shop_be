import { randomUUID } from 'node:crypto';
import {
  EquipmentStatus,
  Prisma,
  PrismaClient,
  SettingValueType,
} from '@prisma/client';

describe('Equipment and setting database invariants (e2e)', () => {
  const prisma = new PrismaClient();
  const suffix = randomUUID();

  let positionId: string;
  let employeeId: string;
  let equipmentId: string;
  let settingId: string;

  beforeAll(async () => {
    const position = await prisma.position.create({
      data: { name: `Asset Position ${suffix}`, salary: 0 },
    });
    positionId = position.id;

    const employee = await prisma.employee.create({
      data: {
        email: `asset-${suffix}@example.com`,
        username: `asset-${suffix}`,
        fullName: 'Asset Test Employee',
        password: 'not-used-in-equipment-tests',
        positionId,
      },
    });
    employeeId = employee.id;

    const equipment = await prisma.equipment.create({
      data: {
        assetCode: `TEST-${suffix}`,
        name: 'Invariant test equipment',
        quantity: 2,
        unitPrice: new Prisma.Decimal('100.00'),
        totalAmount: new Prisma.Decimal('200.00'),
        purchaseDate: new Date('2026-01-01T00:00:00.000Z'),
        employeeId,
      },
    });
    equipmentId = equipment.id;

    const setting = await prisma.systemSetting.create({
      data: {
        key: `test.${suffix}`,
        value: 'UTC',
        valueType: SettingValueType.STRING,
        updatedById: employeeId,
      },
    });
    settingId = setting.id;
  });

  afterAll(async () => {
    try {
      await prisma.systemSettingRevision.deleteMany({ where: { settingId } });
      await prisma.systemSetting.deleteMany({ where: { id: settingId } });
      await prisma.equipmentLifecycleEvent.deleteMany({
        where: { equipmentId },
      });
      await prisma.equipment.deleteMany({ where: { id: equipmentId } });
      await prisma.employee.deleteMany({ where: { id: employeeId } });
      await prisma.position.deleteMany({ where: { id: positionId } });
    } finally {
      await prisma.$disconnect();
    }
  });

  it('rejects an equipment total inconsistent with quantity and unit price', async () => {
    await expect(
      prisma.$executeRaw(
        Prisma.sql`
          UPDATE "Equipment"
          SET "totalAmount" = 1
          WHERE "id" = ${equipmentId}
        `,
      ),
    ).rejects.toBeDefined();
  });

  it('requires a liquidation timestamp for liquidated equipment', async () => {
    await expect(
      prisma.$executeRaw(
        Prisma.sql`
          UPDATE "Equipment"
          SET "status" = 'LIQUIDATED'
          WHERE "id" = ${equipmentId}
        `,
      ),
    ).rejects.toBeDefined();
  });

  it('rejects lifecycle events that do not change status', async () => {
    await expect(
      prisma.equipmentLifecycleEvent.create({
        data: {
          equipmentId,
          employeeId,
          fromStatus: EquipmentStatus.IN_USE,
          toStatus: EquipmentStatus.IN_USE,
          reason: 'Invalid no-op transition',
        },
      }),
    ).rejects.toBeDefined();
  });

  it('rejects a JSON value that conflicts with the declared setting type', async () => {
    await expect(
      prisma.$executeRaw(
        Prisma.sql`
          UPDATE "SystemSetting"
          SET "value" = to_jsonb(123::integer)
          WHERE "id" = ${settingId}
        `,
      ),
    ).rejects.toBeDefined();
  });

  it('keeps one immutable snapshot per setting version', async () => {
    const createRevision = () =>
      prisma.systemSettingRevision.create({
        data: {
          settingId,
          employeeId,
          version: 1,
          value: 'UTC',
          valueType: SettingValueType.STRING,
          isPublic: false,
        },
      });

    await expect(createRevision()).resolves.toBeDefined();
    await expect(createRevision()).rejects.toBeDefined();
  });
});
