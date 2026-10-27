import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { ConflictException, Logger, NotFoundException } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import {
  PrismaService,
  type ExtendedPrismaClient,
} from '../src/common/prisma/prisma.service';
import { PaginationUtilService } from '../src/common/utils/pagination-util/pagination-util.service';
import { QueryUtilService } from '../src/common/utils/query-util/query-util.service';
import { ExcelUtilService } from '../src/common/utils/excel-util/excel-util.service';
import { EquipmentService } from '../src/app/equipment/equipment.service';
import { RolesService } from '../src/app/roles/roles.service';
import { InventoryRepository } from '../src/app/inventory/repositories/inventory.repository';
import { InventoryPolicyService } from '../src/app/inventory/policies/inventory-policy.service';
import { InventoryAuditService } from '../src/app/inventory/services/inventory-audit.service';
import { InventoryCategoryService } from '../src/app/inventory/services/inventory-category.service';
import { InventoryQueryService } from '../src/app/inventory/services/inventory-query.service';
import { InventoryTransactionService } from '../src/app/inventory/services/inventory-transaction.service';

describe('Prisma workflow safety (isolated PostgreSQL)', () => {
  const originalUrl = process.env.DATABASE_URL;
  const name = `prisma_workflow_${randomUUID().replaceAll('-', '')}_test`;
  const pagination = new PaginationUtilService();
  const query = new QueryUtilService();
  let admin: PrismaClient | undefined;
  let base: PrismaService;
  let db: ExtendedPrismaClient;
  let created = false;
  let actorId: string;

  beforeAll(async () => {
    const target = new URL(originalUrl ?? '');
    assert(
      process.env.NODE_ENV === 'test' &&
        ['localhost', '127.0.0.1'].includes(target.hostname),
      'Loopback PostgreSQL test environment required.',
    );
    target.pathname = '/postgres';
    admin = new PrismaClient({ datasources: { db: { url: target.href } } });
    assert(/^prisma_workflow_[a-f0-9]{32}_test$/.test(name));
    await admin.$executeRawUnsafe(`CREATE DATABASE "${name}"`);
    created = true;
    target.pathname = `/${name}`;
    target.searchParams.set('connection_limit', '4');
    process.env.DATABASE_URL = target.href;
    execFileSync(
      process.execPath,
      [require.resolve('prisma/build/index.js'), 'migrate', 'deploy'],
      { env: process.env, stdio: 'pipe' },
    );
    base = new PrismaService();
    db = base.getExtendedClient();
    const actor = await db.employee.create({
      data: {
        username: 'prisma-test-operator',
        fullName: 'Test operator',
        email: 'prisma-workflow@example.test',
        password: 'not-a-login',
        position: { create: { name: 'Test operator', salary: 0 } },
      },
    });
    actorId = actor.id;
  }, 60_000);

  beforeEach(() => jest.spyOn(Logger, 'warn').mockImplementation());
  afterEach(() => jest.restoreAllMocks());
  afterAll(async () => {
    try {
      await base?.$disconnect();
    } finally {
      if (originalUrl) process.env.DATABASE_URL = originalUrl;
      else delete process.env.DATABASE_URL;
      try {
        if (created) {
          assert(/^prisma_workflow_[a-f0-9]{32}_test$/.test(name));
          await admin!.$executeRawUnsafe(
            `DROP DATABASE "${name}" WITH (FORCE)`,
          );
        }
      } finally {
        await admin?.$disconnect();
      }
    }
  });

  const equipment = (client = db) => new EquipmentService(client, pagination);
  const categoryService = (client = db) => {
    const repository = new InventoryRepository(client);
    return new InventoryCategoryService(
      repository,
      pagination,
      query,
      new InventoryPolicyService(),
      new InventoryTransactionService(repository),
      new InventoryAuditService(),
    );
  };
  const createEquipment = () =>
    equipment().create(actorId, {
      assetCode: `EQ-${randomUUID()}`,
      name: 'Test machine',
      quantity: 1,
      unitPrice: '100',
      purchaseDate: new Date(Date.now() - 86_400_000),
    });

  it('cannot edit metadata when liquidation commits after the edit reads the row', async () => {
    const item = await createEquipment();
    const observed = Promise.withResolvers<void>();
    const resume = Promise.withResolvers<void>();
    let reads = 0;
    const paused = db.$extends({
      query: {
        equipment: {
          async findFirst({ args, query: run }) {
            const row = await run(args);
            if (++reads === 1) {
              observed.resolve();
              await resume.promise;
            }
            return row;
          },
        },
      },
    });
    const outcome = equipment(paused)
      .update(item.id, actorId, {
        name: 'Must not persist',
        expectedUpdatedAt: item.updatedAt,
      })
      .then(
        () => null,
        (error) => error as unknown,
      );
    try {
      await observed.promise;
      await equipment().transition(item.id, actorId, {
        status: 'LIQUIDATED',
        reason: 'Retired during edit',
        cost: '0',
      });
    } finally {
      resume.resolve();
    }
    expect(await outcome).toBeInstanceOf(ConflictException);
    expect(reads).toBeGreaterThan(1);
    expect(
      await db.equipment.findUniqueOrThrow({ where: { id: item.id } }),
    ).toMatchObject({ name: 'Test machine', status: 'LIQUIDATED' });
    expect(
      await db.actionLog.count({
        where: {
          actionType: 'EQUIPMENT_UPDATED',
          details: { path: ['equipmentId'], equals: item.id },
        },
      }),
    ).toBe(0);
  }, 15_000);

  it('rejects a stale form after a competing price update', async () => {
    const item = await createEquipment();
    const observed = Promise.withResolvers<void>();
    const resume = Promise.withResolvers<void>();
    let reads = 0;
    const paused = db.$extends({
      query: {
        equipment: {
          async findFirst({ args, query: run }) {
            const row = await run(args);
            if (++reads === 1) {
              observed.resolve();
              await resume.promise;
            }
            return row;
          },
        },
      },
    });
    const update = equipment(paused)
      .update(item.id, actorId, {
        quantity: 3,
        expectedUpdatedAt: item.updatedAt,
      })
      .catch((error: unknown) => error);
    try {
      await observed.promise;
      await equipment().update(item.id, actorId, {
        unitPrice: '200',
        expectedUpdatedAt: item.updatedAt,
      });
    } finally {
      resume.resolve();
    }
    expect(await update).toBeInstanceOf(ConflictException);
    expect(reads).toBeGreaterThan(1);
    const saved = await db.equipment.findUniqueOrThrow({
      where: { id: item.id },
    });
    expect(saved.quantity).toBe(item.quantity);
    expect(saved.unitPrice.toFixed(2)).toBe('200.00');
    expect(saved.totalAmount.toFixed(2)).toBe(
      saved.unitPrice.mul(item.quantity).toFixed(2),
    );
  }, 15_000);

  it('cannot modify an inventory category archived after its active-state check', async () => {
    const category = await db.inventoryCategory.create({
      data: { name: 'Archive race' },
    });
    const observed = Promise.withResolvers<void>();
    const resume = Promise.withResolvers<void>();
    let reads = 0;
    const paused = db.$extends({
      query: {
        inventoryCategory: {
          async findFirst({ args, query: run }) {
            const row = await run(args);
            if (++reads === 1) {
              observed.resolve();
              await resume.promise;
            }
            return row;
          },
        },
      },
    });
    const outcome = categoryService(paused)
      .update(category.id, actorId, { description: 'Must not persist' })
      .then(
        () => null,
        (error) => error as unknown,
      );
    try {
      await observed.promise;
      await categoryService().remove(category.id, actorId);
    } finally {
      resume.resolve();
    }
    expect(await outcome).toBeInstanceOf(NotFoundException);
    expect(reads).toBeGreaterThan(1);
    const saved = await base.inventoryCategory.findUniqueOrThrow({
      where: { id: category.id },
    });
    expect(saved.deletedAt).not.toBeNull();
    expect(saved.description).toBeNull();
    expect(
      await db.actionLog.count({
        where: { actionType: 'INVENTORY_CATEGORY_UPDATED' },
      }),
    ).toBe(0);
  }, 15_000);

  it('exports scalar role metadata without permission or employee junctions', async () => {
    const permission = await db.permission.create({
      data: { name: 'Test read', key: '/audit_read' },
    });
    const role = await db.role.create({
      data: {
        name: 'Export test',
        rolePermissions: { create: { permissionId: permission.id } },
        employeeRoles: { create: { employeeId: actorId } },
      },
    });
    const service = new RolesService(
      db,
      pagination,
      query,
      new ExcelUtilService(),
      {} as never,
    );
    const workbook = await service.exportRoles({
      ids: [role.id],
      select: null,
    });
    expect(workbook.worksheets[0].columns.map((column) => column.key)).toEqual([
      'name',
      'description',
      'isSystemRole',
      'createdAt',
      'updatedAt',
    ]);
    expect(JSON.stringify(workbook.worksheets[0].getRow(2).values)).not.toMatch(
      /permissionId|employeeId/,
    );
  });

  it('paginates timestamp ties without duplicate or missing ingredients', async () => {
    const category = await db.inventoryCategory.create({
      data: { name: 'Pagination test' },
    });
    const unit = await db.unit.create({ data: { name: 'Test unit' } });
    const timestamp = new Date('2026-01-01T00:00:00Z');
    await db.inventoryItem.createMany({
      data: Array.from({ length: 32 }, (_, index) => ({
        name: `Ingredient ${index}`,
        categoryId: category.id,
        unitId: unit.id,
        createdAt: timestamp,
      })),
    });
    const service = new InventoryQueryService(
      new InventoryRepository(db),
      pagination,
      query,
    );
    const ids: string[] = [];
    for (let page = 1; page <= 4; page++) {
      const result = await service.findItems({
        page,
        itemPerPage: 10,
        categoryId: category.id,
        lowStockOnly: false,
      });
      expect(result.totalItems).toBe(32);
      ids.push(
        ...result.list.map((item) => {
          assert(typeof item.id === 'string');
          return item.id;
        }),
      );
    }
    expect(ids).toHaveLength(32);
    expect(new Set(ids).size).toBe(32);
    expect(ids).toEqual([...ids].sort());
  });
});
