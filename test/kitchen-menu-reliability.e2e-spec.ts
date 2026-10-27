import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { PrismaClient, ServeStatus } from '@prisma/client';
import {
  PrismaService,
  type ExtendedPrismaClient,
} from '../src/common/prisma/prisma.service';
import { PaginationUtilService } from '../src/common/utils/pagination-util/pagination-util.service';
import { KitchenService } from '../src/app/kitchen/kitchen.service';
import { MenuService } from '../src/app/menu/menu.service';

describe('Kitchen queue and menu concurrency (isolated PostgreSQL)', () => {
  const originalUrl = process.env.DATABASE_URL;
  const databaseName = `kitchen_menu_${randomUUID().replaceAll('-', '')}_test`;
  let created = false;
  let admin: PrismaClient;
  let base: PrismaService;
  let db: ExtendedPrismaClient;
  let menu: MenuService;
  let kitchen: KitchenService;
  let employeeId: string;
  let menuItemId: string;
  let inventoryItemId: string;

  beforeAll(async () => {
    const target = new URL(process.env.DATABASE_URL ?? '');
    assert(
      process.env.NODE_ENV === 'test' &&
        ['localhost', '127.0.0.1'].includes(target.hostname) &&
        target.pathname.endsWith('_test'),
      'Dedicated loopback test configuration required.',
    );
    const adminUrl = new URL(target);
    adminUrl.pathname = '/postgres';
    admin = new PrismaClient({ datasources: { db: { url: adminUrl.href } } });
    await admin.$executeRawUnsafe(`CREATE DATABASE "${databaseName}"`);
    created = true;
    target.pathname = `/${databaseName}`;
    process.env.DATABASE_URL = target.href;
    execFileSync(
      process.execPath,
      [require.resolve('prisma/build/index.js'), 'migrate', 'deploy'],
      { env: process.env, stdio: 'pipe' },
    );
    base = new PrismaService();
    db = base.getExtendedClient();
    menu = new MenuService(db, new PaginationUtilService(), {} as never);
    kitchen = new KitchenService(db, new PaginationUtilService());
    const position = await db.position.create({
      data: { name: 'Test operator', salary: 0 },
    });
    const employee = await db.employee.create({
      data: {
        email: 'kitchen@example.test',
        username: 'kitchen-test',
        fullName: 'Kitchen test',
        password: 'not-a-login',
        positionId: position.id,
      },
    });
    employeeId = employee.id;
    const category = await db.menuCategory.create({
      data: { name: 'Test drinks' },
    });
    const item = await db.menuItem.create({
      data: { name: 'Test latte', price: '35000', categoryId: category.id },
    });
    menuItemId = item.id;
    const unit = await db.unit.create({ data: { name: 'kg' } });
    const inventoryCategory = await db.inventoryCategory.create({
      data: { name: 'Test ingredients' },
    });
    const ingredient = await db.inventoryItem.create({
      data: {
        name: 'Test beans',
        unitId: unit.id,
        categoryId: inventoryCategory.id,
      },
    });
    inventoryItemId = ingredient.id;
    const session = await db.orderSession.create({ data: { employeeId } });
    const station = await db.kitchenStation.create({
      data: { code: 'TEST', name: 'Test bar' },
    });
    for (const serveStatus of Object.values(ServeStatus)) {
      const orderItem = await db.orderItem.create({
        data: {
          menuItemId,
          orderSessionId: session.id,
          priceAtTime: '35000',
          quantity: 1,
          serveStatus,
        },
      });
      await db.kitchenTicket.create({
        data: {
          orderSessionId: session.id,
          stationId: station.id,
          dueAt: new Date(Date.now() + 900_000),
          items: {
            create: {
              orderItemId: orderItem.id,
              itemName: 'Test latte',
              quantity: 1,
            },
          },
        },
      });
    }
  }, 120_000);

  afterAll(async () => {
    await base?.$disconnect();
    process.env.DATABASE_URL = originalUrl;
    if (created)
      await admin.$executeRawUnsafe(
        `DROP DATABASE "${databaseName}" WITH (FORCE)`,
      );
    await admin?.$disconnect();
  });

  it('keeps READY in the default queue until handed off, without including finished history', async () => {
    const query = {
      page: 1,
      itemPerPage: 100,
      includeScheduled: false,
      includeCompleted: false,
    };
    const queued = await kitchen.getTickets(query);
    expect(queued.totalItems).toBe(3);
    expect(
      queued.list
        .flatMap((ticket) => ticket.items.map((item) => item.serveStatus))
        .sort(),
    ).toEqual(['COOKING', 'PENDING', 'READY']);
    await db.orderItem.updateMany({
      where: { serveStatus: 'READY' },
      data: { serveStatus: 'SERVED' },
    });
    expect((await kitchen.getTickets(query)).totalItems).toBe(2);
    expect(
      (await kitchen.getTickets({ ...query, includeCompleted: true }))
        .totalItems,
    ).toBe(5);
  });

  it('allows only one concurrent recipe save from the same observed revision', async () => {
    const { revision } = await menu.getItemRecipe(menuItemId);
    const results = await Promise.allSettled(
      ['0.1000', '0.2000'].map((quantity) =>
        menu.replaceItemRecipe(menuItemId, employeeId, {
          expectedRevision: revision,
          ingredients: [{ inventoryItemId, quantity }],
        }),
      ),
    );
    const saved = results.filter((result) => result.status === 'fulfilled');
    expect(saved).toHaveLength(1);
    expect(
      results.find((result) => result.status === 'rejected'),
    ).toMatchObject({
      reason: { response: { code: 'MENU_CONFIGURATION_CHANGED' } },
    });
    const current = await menu.getItemRecipe(menuItemId);
    if (saved[0].status === 'fulfilled')
      expect(current.revision).toBe(saved[0].value.revision);
    expect(
      await db.actionLog.count({
        where: { actionType: 'MENU_RECIPE_REPLACED' },
      }),
    ).toBe(1);
    await menu.replaceItemRecipe(menuItemId, employeeId, {
      expectedRevision: current.revision,
      ingredients: current.ingredients.map(({ inventoryItemId, quantity }) => ({
        inventoryItemId,
        quantity: quantity.toFixed(4),
      })),
    });
    expect(
      await db.actionLog.count({
        where: { actionType: 'MENU_RECIPE_REPLACED' },
      }),
    ).toBe(1);
  });

  it('rejects stale option saves and preserves option IDs on an unchanged replacement', async () => {
    const { revision } = await menu.getItemOptions(menuItemId);
    const groups = (priceDelta: string) => [
      {
        name: 'Size',
        minSelected: 0,
        maxSelected: 1,
        options: [{ name: 'Large', priceDelta, ingredients: [] }],
      },
    ];
    const results = await Promise.allSettled(
      ['1000', '2000'].map((priceDelta) =>
        menu.replaceItemOptions(menuItemId, employeeId, {
          expectedRevision: revision,
          groups: groups(priceDelta),
        }),
      ),
    );
    expect(
      results.filter((result) => result.status === 'fulfilled'),
    ).toHaveLength(1);
    expect(
      results.find((result) => result.status === 'rejected'),
    ).toMatchObject({
      reason: { response: { code: 'MENU_CONFIGURATION_CHANGED' } },
    });
    const current = await menu.getItemOptions(menuItemId);
    const unchanged = await menu.replaceItemOptions(menuItemId, employeeId, {
      expectedRevision: current.revision,
      groups: groups(current.optionGroups[0].options[0].priceDelta.toFixed(2)),
    });
    expect(unchanged.optionGroups[0].options[0].id).toBe(
      current.optionGroups[0].options[0].id,
    );
    expect(unchanged.revision).toBe(current.revision);
    expect(
      await db.actionLog.count({
        where: { actionType: 'MENU_OPTIONS_REPLACED' },
      }),
    ).toBe(1);
  });
});
