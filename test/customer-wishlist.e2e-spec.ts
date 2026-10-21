import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { INestApplication, UnauthorizedException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ThrottlerGuard } from '@nestjs/throttler';
import { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from '../src/app/app.module';
import { GoogleIdentityService } from '../src/app/auth/google-identity.service';
import { TurnstileService } from '../src/app/auth/turnstile.service';
import {
  CUSTOMER_CSRF_COOKIE,
  CUSTOMER_SESSION_COOKIE,
} from '../src/common/consts/customer-auth';
import { PrismaService } from '../src/common/prisma/prisma.service';
import { initApp } from '../src/init';
import { buildCatalogData, seedCatalog } from '../prisma/catalog-data';

describe('Customer wishlist with isolated PostgreSQL', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  const suffix = randomUUID();
  const tokenFor = (name: string) => `${name}-${'x'.repeat(100)}`;
  let categoryId: string;
  let items: Array<{ id: string }>;
  let customerA: { id: string; email: string };
  let customerB: { id: string; email: string };
  let cookiesA: string;
  let csrfA: string;
  let cookiesB: string;
  let csrfB: string;
  let throttle: jest.SpyInstance;

  const clearCatalogFixtures = async () => {
    const demo = buildCatalogData(1);
    const menuIds = demo.menuItems.map((item) => item.id);
    const stockIds = demo.inventoryItems.map((item) => item.id);
    await prisma.$transaction(async (tx) => {
      await tx.menuItemIngredient.deleteMany({
        where: { menuItemId: { in: menuIds } },
      });
      await tx.inventoryTransaction.deleteMany({
        where: { inventoryItemId: { in: stockIds } },
      });
      await tx.menuItem.deleteMany({ where: { id: { in: menuIds } } });
      await tx.inventoryItem.deleteMany({ where: { id: { in: stockIds } } });
      await tx.menuCategory.deleteMany({
        where: { id: { in: demo.categories.map((item) => item.id) } },
      });
      await tx.inventoryCategory.deleteMany({
        where: { id: demo.inventoryCategory.id },
      });
      await tx.unit.deleteMany({
        where: { id: { in: demo.units.map((item) => item.id) } },
      });
      await tx.kitchenStation.deleteMany({
        where: { id: { in: demo.stations.map((item) => item.id) } },
      });
      await tx.diningTable.deleteMany({
        where: { id: { in: demo.tables.map((item) => item.id) } },
      });
    });
  };

  const login = async (name: string) => {
    const response = await request(app.getHttpServer())
      .post('/api/v1/customers/auth/google')
      .send({ idToken: tokenFor(name), turnstileToken: 'fixture-human' })
      .expect(200);
    const headers = response.headers['set-cookie'] as unknown as string[];
    const cookie = headers.map((value) => value.split(';')[0]).join('; ');
    const csrf = headers
      .find((value) => value.startsWith(`${CUSTOMER_CSRF_COOKIE}=`))!
      .split(';')[0]
      .slice(CUSTOMER_CSRF_COOKIE.length + 1);
    return {
      cookie,
      csrf,
      customer: response.body.data.customer as { id: string; email: string },
      headers,
    };
  };

  beforeAll(async () => {
    const target = new URL(process.env.DATABASE_URL ?? '');
    assert(
      process.env.NODE_ENV === 'test' &&
        ['localhost', '127.0.0.1'].includes(target.hostname) &&
        target.pathname.endsWith('_test'),
      'Use an isolated loopback test database, not the business DB.',
    );
    throttle = jest
      .spyOn(ThrottlerGuard.prototype, 'canActivate')
      .mockResolvedValue(true);
    const module = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(GoogleIdentityService)
      .useValue({
        verify: (token: string) => {
          const name = ['customer-a', 'customer-b'].find(
            (value) => token === tokenFor(value),
          );
          if (!name)
            throw new UnauthorizedException('Invalid fixture identity');
          return Promise.resolve({
            subject: `${name}-${suffix}`,
            email: `${name}-${suffix}@example.test`,
          });
        },
      })
      .overrideProvider(TurnstileService)
      .useValue({
        verify: (token: string) => {
          if (token !== 'fixture-human')
            throw new UnauthorizedException('Invalid fixture verification');
          return Promise.resolve();
        },
      })
      .compile();
    const server = module.createNestApplication<NestExpressApplication>();
    initApp(server);
    app = server;
    prisma = module.get(PrismaService);
    await app.init();
    const category = await prisma.menuCategory.create({
      data: { name: `Wishlist ${suffix}` },
    });
    categoryId = category.id;
    await prisma.menuItem.createMany({
      data: Array.from({ length: 102 }, (_, index) => ({
        name: `Wishlist ${suffix} ${index}`,
        categoryId,
        price: '35000',
      })),
    });
    items = await prisma.menuItem.findMany({
      where: { categoryId },
      orderBy: { name: 'asc' },
      select: { id: true },
    });
    const a = await login('customer-a');
    const b = await login('customer-b');
    customerA = a.customer;
    cookiesA = a.cookie;
    csrfA = a.csrf;
    customerB = b.customer;
    cookiesB = b.cookie;
    csrfB = b.csrf;
  }, 60000);

  beforeEach(async () => {
    await prisma.customer.updateMany({
      where: { id: { in: [customerA.id, customerB.id] } },
      data: { isActive: true, deletedAt: null },
    });
    await prisma.customerWishlist.deleteMany({
      where: { customerId: { in: [customerA.id, customerB.id] } },
    });
    await prisma.menuItem.updateMany({
      where: { categoryId },
      data: { price: '35000', isAvailable: true, deletedAt: null },
    });
    const a = await login('customer-a');
    const b = await login('customer-b');
    cookiesA = a.cookie;
    csrfA = a.csrf;
    cookiesB = b.cookie;
    csrfB = b.csrf;
  });

  afterAll(async () => {
    try {
      if (prisma) {
        await clearCatalogFixtures();
        await prisma.customer.deleteMany({
          where: { googleSubject: { endsWith: suffix } },
        });
        if (categoryId) {
          await prisma.menuItem.deleteMany({ where: { categoryId } });
          await prisma.menuCategory.delete({ where: { id: categoryId } });
        }
      }
    } finally {
      await app?.close();
      throttle?.mockRestore();
    }
  });

  it('uses hashed, HttpOnly customer sessions and never grants staff authentication', async () => {
    const a = await login('customer-a');
    const sessionHeader = a.headers.find((value) =>
      value.startsWith(`${CUSTOMER_SESSION_COOKIE}=`),
    )!;
    expect(sessionHeader).toContain('HttpOnly');
    expect(a.headers.some((value) => value.startsWith('accessToken='))).toBe(
      false,
    );
    const raw = sessionHeader
      .split(';')[0]
      .slice(CUSTOMER_SESSION_COOKIE.length + 1);
    expect(
      await prisma.customerSession.findUnique({
        where: { tokenHash: createHash('sha256').update(raw).digest('hex') },
      }),
    ).not.toBeNull();
    expect(
      await prisma.customerSession.findUnique({ where: { tokenHash: raw } }),
    ).toBeNull();
    await request(app.getHttpServer())
      .get('/api/v1/auth/me')
      .set('Cookie', a.cookie)
      .expect(401);
    await request(app.getHttpServer())
      .get('/api/v1/customers/me')
      .set('Cookie', 'accessToken=employee-token')
      .expect(401);
  });

  it('syncs across devices, is idempotent, and cannot read or delete another customer favorites', async () => {
    const put = () =>
      request(app.getHttpServer())
        .put(`/api/v1/customers/wishlist/${items[0].id}`)
        .set('Cookie', cookiesA)
        .set('X-CSRF-Token', csrfA)
        .send({ expectedCustomerId: customerA.id });
    await Promise.all([put().expect(200), put().expect(200)]);
    expect(
      await prisma.customerWishlist.count({
        where: { customerId: customerA.id, menuItemId: items[0].id },
      }),
    ).toBe(1);
    const device = await login('customer-a');
    const result = await request(app.getHttpServer())
      .get('/api/v1/customers/wishlist')
      .set('Cookie', device.cookie)
      .expect(200);
    expect(result.headers['cache-control']).toBe('no-store');
    expect(result.body.data.items[0].menuItemId).toBe(items[0].id);
    expect(
      (
        await request(app.getHttpServer())
          .get('/api/v1/customers/wishlist')
          .set('Cookie', cookiesB)
          .expect(200)
      ).body.data.items,
    ).toEqual([]);
    await request(app.getHttpServer())
      .delete(`/api/v1/customers/wishlist/${items[0].id}`)
      .set('Cookie', cookiesB)
      .set('X-CSRF-Token', csrfB)
      .send({ expectedCustomerId: customerB.id })
      .expect(200);
    expect(
      await prisma.customerWishlist.count({
        where: { customerId: customerA.id },
      }),
    ).toBe(1);
    await request(app.getHttpServer())
      .put(`/api/v1/customers/wishlist/${items[1].id}`)
      .set('Cookie', cookiesB)
      .set('X-CSRF-Token', csrfB)
      .send({ expectedCustomerId: customerA.id })
      .expect(409);
  });

  it('rejects missing CSRF including fake bearer headers, and uses current price/availability', async () => {
    await request(app.getHttpServer())
      .put(`/api/v1/customers/wishlist/${items[1].id}`)
      .set('Cookie', cookiesA)
      .set('Authorization', 'Bearer fake')
      .send({ expectedCustomerId: customerA.id })
      .expect(403);
    await request(app.getHttpServer())
      .put(`/api/v1/customers/wishlist/${items[0].id}`)
      .set('Cookie', cookiesA)
      .set('X-CSRF-Token', csrfA)
      .send({ expectedCustomerId: customerA.id })
      .expect(200);
    await prisma.menuItem.update({
      where: { id: items[0].id },
      data: { price: '42000', isAvailable: false },
    });
    const result = await request(app.getHttpServer())
      .get('/api/v1/customers/wishlist')
      .set('Cookie', cookiesA)
      .expect(200);
    expect(result.body.data.items[0].item).toMatchObject({
      price: 42000,
      isAvailable: false,
    });
    await prisma.menuItem.update({
      where: { id: items[0].id },
      data: { deletedAt: new Date() },
    });
    expect(
      (
        await request(app.getHttpServer())
          .get('/api/v1/customers/wishlist')
          .set('Cookie', cookiesA)
          .expect(200)
      ).body.data.items[0].item,
    ).toBeNull();
    await request(app.getHttpServer())
      .delete(`/api/v1/customers/wishlist/${items[0].id}`)
      .set('Cookie', cookiesA)
      .set('X-CSRF-Token', csrfA)
      .send({ expectedCustomerId: customerA.id })
      .expect(200);
  });

  it('enforces the wishlist size under concurrent writes', async () => {
    await prisma.customerWishlist.createMany({
      data: items
        .slice(0, 99)
        .map((item) => ({ customerId: customerA.id, menuItemId: item.id })),
    });
    const responses = await Promise.all(
      items
        .slice(99, 101)
        .map((item) =>
          request(app.getHttpServer())
            .put(`/api/v1/customers/wishlist/${item.id}`)
            .set('Cookie', cookiesA)
            .set('X-CSRF-Token', csrfA)
            .send({ expectedCustomerId: customerA.id }),
        ),
    );
    expect(responses.map((response) => response.status).sort()).toEqual([
      200, 409,
    ]);
    expect(
      await prisma.customerWishlist.count({
        where: { customerId: customerA.id },
      }),
    ).toBe(100);
  });

  it('rejects inactive customers and revoked/expired sessions', async () => {
    await prisma.customer.update({
      where: { id: customerB.id },
      data: { isActive: false },
    });
    await request(app.getHttpServer())
      .get('/api/v1/customers/me')
      .set('Cookie', cookiesB)
      .expect(401);
    await request(app.getHttpServer())
      .post('/api/v1/customers/auth/google')
      .send({
        idToken: tokenFor('customer-b'),
        turnstileToken: 'fixture-human',
      })
      .expect(401);
    await prisma.customer.update({
      where: { id: customerB.id },
      data: { isActive: true },
    });
    await request(app.getHttpServer())
      .post('/api/v1/customers/auth/logout')
      .set('Cookie', cookiesB)
      .set('X-CSRF-Token', csrfB)
      .expect(200);
    await request(app.getHttpServer())
      .get('/api/v1/customers/me')
      .set('Cookie', cookiesB)
      .expect(401);
    const device = await login('customer-b');
    await prisma.customerSession.updateMany({
      where: { customerId: customerB.id },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    await request(app.getHttpServer())
      .get('/api/v1/customers/me')
      .set('Cookie', device.cookie)
      .expect(401);
  });

  it('revokes the previous browser session on account switch without moving favorites', async () => {
    await request(app.getHttpServer())
      .put(`/api/v1/customers/wishlist/${items[0].id}`)
      .set('Cookie', cookiesA)
      .set('X-CSRF-Token', csrfA)
      .send({ expectedCustomerId: customerA.id })
      .expect(200);
    const response = await request(app.getHttpServer())
      .post('/api/v1/customers/auth/google')
      .set('Cookie', cookiesA)
      .send({
        idToken: tokenFor('customer-b'),
        turnstileToken: 'fixture-human',
      })
      .expect(200);
    const headers = response.headers['set-cookie'] as unknown as string[];
    const cookie = headers.map((value) => value.split(';')[0]).join('; ');
    await request(app.getHttpServer())
      .get('/api/v1/customers/me')
      .set('Cookie', cookiesA)
      .expect(401);
    expect(response.body.data.customer.id).toBe(customerB.id);
    expect(
      (
        await request(app.getHttpServer())
          .get('/api/v1/customers/wishlist')
          .set('Cookie', cookie)
          .expect(200)
      ).body.data.items,
    ).toEqual([]);
    expect(
      await prisma.customerWishlist.count({
        where: { customerId: customerA.id },
      }),
    ).toBe(1);
  });

  it('limits active sessions without deleting customer favorites', async () => {
    const first = await login('customer-a');
    for (let index = 0; index < 11; index++) await login('customer-a');
    expect(
      await prisma.customerSession.count({
        where: { customerId: customerA.id },
      }),
    ).toBe(10);
    await request(app.getHttpServer())
      .get('/api/v1/customers/me')
      .set('Cookie', first.cookie)
      .expect(401);
    const latest = await login('customer-a');
    await request(app.getHttpServer())
      .get('/api/v1/customers/me')
      .set('Cookie', latest.cookie)
      .expect(200);
  });

  it('rejects unverified identity without creating a customer or cookies', async () => {
    const before = await prisma.customer.count();
    const response = await request(app.getHttpServer())
      .post('/api/v1/customers/auth/google')
      .send({ idToken: tokenFor('invalid'), turnstileToken: 'fixture-human' })
      .expect(401);
    expect(response.headers['set-cookie']).toBeUndefined();
    await request(app.getHttpServer())
      .post('/api/v1/customers/auth/google')
      .send({ idToken: tokenFor('customer-a'), turnstileToken: 'invalid' })
      .expect(401);
    expect(await prisma.customer.count()).toBe(before);
  });

  it('seeds catalog once without financial writes and preserves edits/stock on replay', async () => {
    await clearCatalogFixtures();
    const before = {
      invoices: await prisma.invoice.count(),
      payments: await prisma.paymentAttempt.count(),
      cashTransactions: await prisma.cashTransaction.count(),
      inventoryTransactions: await prisma.inventoryTransaction.count(),
      funds: await prisma.fund.count(),
    };
    const inserted = await seedCatalog(prisma, 1);
    expect(inserted).toMatchObject({
      menuItems: 44,
      inventoryItems: 32,
      tables: 10,
    });
    const demo = buildCatalogData(1);
    const stock = demo.inventoryItems[0];
    expect(
      await prisma.menuItem.count({
        where: {
          id: { in: demo.menuItems.map((item) => item.id) },
          isAvailable: true,
        },
      }),
    ).toBe(0);
    expect(await prisma.inventoryTransaction.count()).toBe(
      before.inventoryTransactions,
    );
    expect(await prisma.fund.count()).toBe(before.funds);
    await prisma.$transaction(async (tx) => {
      await tx.inventoryItem.update({
        where: { id: stock.id },
        data: { stock: '2.5000', averageUnitCost: '320000' },
      });
      await tx.inventoryTransaction.create({
        data: {
          inventoryItemId: stock.id,
          type: 'IMPORT',
          quantity: '2.5000',
          unitPrice: '320000',
          totalAmount: '800000',
          transactionDate: new Date(),
        },
      });
    });
    await prisma.menuItem.update({
      where: { id: demo.menuItems[0].id },
      data: { name: 'Edited catalog name', price: '49999', isAvailable: true },
    });
    const firstRecipe = demo.recipes[0];
    const recipeKey = {
      menuItemId: firstRecipe.menuItemId,
      inventoryItemId: firstRecipe.inventoryItemId,
    };
    await prisma.menuItemIngredient.update({
      where: { menuItemId_inventoryItemId: recipeKey },
      data: { quantity: '0.0300' },
    });
    const retired = demo.menuItems[1];
    const retiredAt = new Date();
    await prisma.menuItem.update({
      where: { id: retired.id },
      data: { deletedAt: retiredAt, isAvailable: false },
    });
    expect(await seedCatalog(prisma, 999)).toEqual({
      units: 0,
      inventoryItems: 0,
      inventoryCategories: 0,
      kitchenStations: 0,
      menuCategories: 0,
      menuItems: 0,
      recipes: 0,
      tables: 0,
    });
    expect(
      (
        await prisma.inventoryItem.findUniqueOrThrow({
          where: { id: stock.id },
        })
      ).stock.equals('2.5000'),
    ).toBe(true);
    expect(
      (
        await prisma.menuItem.findUniqueOrThrow({
          where: { id: demo.menuItems[0].id },
        })
      ).name,
    ).toBe('Edited catalog name');
    expect(
      await prisma.menuItem.findUnique({ where: { id: retired.id } }),
    ).toMatchObject({ deletedAt: retiredAt, isAvailable: false });
    expect(
      await prisma.menuItem.findUnique({ where: { id: demo.menuItems[0].id } }),
    ).toMatchObject({ isAvailable: true });
    expect(
      (
        await prisma.menuItemIngredient.findUniqueOrThrow({
          where: { menuItemId_inventoryItemId: recipeKey },
        })
      ).quantity.toString(),
    ).toBe('0.03');
    const rows = await prisma.inventoryTransaction.findMany({
      where: { inventoryItemId: stock.id },
    });
    expect(
      rows.reduce(
        (value, row) =>
          value +
          (row.type === 'IMPORT'
            ? Number(row.quantity)
            : -Number(row.quantity)),
        0,
      ),
    ).toBe(2.5);
    expect(await prisma.invoice.count()).toBe(before.invoices);
    expect(await prisma.paymentAttempt.count()).toBe(before.payments);
    expect(await prisma.cashTransaction.count()).toBe(before.cashTransactions);
    expect(await prisma.inventoryTransaction.count()).toBe(
      before.inventoryTransactions + 1,
    );
    expect(await prisma.fund.count()).toBe(before.funds);
  });

  it('rolls back the seed instead of linking new dishes to inactive catalog data', async () => {
    await clearCatalogFixtures();
    const demo = buildCatalogData(1);
    const category = demo.categories[0];
    const deletedAt = new Date();
    await prisma.menuCategory.create({ data: { ...category, deletedAt } });
    await expect(seedCatalog(prisma, 1)).rejects.toThrow(
      'Catalog references inactive data',
    );
    expect(
      await prisma.menuItem.count({
        where: { id: { in: demo.menuItems.map((item) => item.id) } },
      }),
    ).toBe(0);
    expect(
      await prisma.inventoryItem.count({
        where: { id: { in: demo.inventoryItems.map((item) => item.id) } },
      }),
    ).toBe(0);
    expect(
      await prisma.unit.count({
        where: { id: { in: demo.units.map((item) => item.id) } },
      }),
    ).toBe(0);
    expect(
      await prisma.menuCategory.findUnique({ where: { id: category.id } }),
    ).toMatchObject({ deletedAt });
  });

  it('replaces only owned demo records, preserves history and rolls back cleanup on seed failure', async () => {
    await clearCatalogFixtures();
    const catalog = buildCatalogData(1);
    const ids = {
      unit: '1eea391b-3e26-41e0-8e19-e74caf3870d9',
      inventoryCategory: 'ca986d92-0317-483c-800e-76b7deb0a5d2',
      inventory: 'a608a615-a24e-4b0f-b1e9-1093df7d68f3',
      unusedInventory: '2157d7cb-0cda-4477-961b-9a2a0f474d92',
      menuCategory: '0ebaf6b8-8646-4e66-b262-16bd252794b2',
      unusedMenu: 'a2b77190-df27-4c70-a6b0-1eaa86ee726f',
      usedMenu: '433ce616-514d-4046-9120-82c3aae99b25',
      fund: '0a9d50be-37fc-4389-a0c1-e72a28ec8646',
      customer: randomUUID(),
      unrelatedMenu: randomUUID(),
      unrelatedCategory: randomUUID(),
      transaction: randomUUID(),
    };
    try {
      await prisma.unit.create({ data: { id: ids.unit, name: 'Demo kg' } });
      await prisma.inventoryCategory.create({
        data: { id: ids.inventoryCategory, name: 'Demo ingredients' },
      });
      await prisma.inventoryItem.createMany({
        data: [
          {
            id: ids.inventory,
            name: 'Demo Coffee beans',
            categoryId: ids.inventoryCategory,
            unitId: ids.unit,
            stock: '2.5000',
            averageUnitCost: '320000',
          },
          {
            id: ids.unusedInventory,
            name: 'Demo Pastry',
            categoryId: ids.inventoryCategory,
            unitId: ids.unit,
          },
        ],
      });
      await prisma.inventoryTransaction.create({
        data: {
          id: ids.transaction,
          inventoryItemId: ids.inventory,
          type: 'IMPORT',
          quantity: '2.5000',
          unitPrice: '320000',
          totalAmount: '800000',
          transactionDate: new Date(),
        },
      });
      await prisma.menuCategory.createMany({
        data: [
          { id: ids.menuCategory, name: 'Demo Coffee' },
          { id: ids.unrelatedCategory, name: `Other catalog ${suffix}` },
        ],
      });
      await prisma.menuItem.createMany({
        data: [
          {
            id: ids.unusedMenu,
            name: 'Demo Espresso',
            categoryId: ids.menuCategory,
            price: 30000,
          },
          {
            id: ids.usedMenu,
            name: 'Demo Americano',
            categoryId: ids.menuCategory,
            price: 35000,
          },
          {
            id: ids.unrelatedMenu,
            name: 'Demo Staff special',
            categoryId: ids.unrelatedCategory,
            price: 40000,
          },
        ],
      });
      await prisma.menuItemIngredient.createMany({
        data: [ids.unusedMenu, ids.usedMenu].map((menuItemId) => ({
          menuItemId,
          inventoryItemId: ids.inventory,
          quantity: '0.0180',
        })),
      });
      await prisma.customer.create({
        data: {
          id: ids.customer,
          googleSubject: `catalog-fixture-${suffix}`,
          email: 'catalog-fixture@example.test',
          wishlist: { create: { menuItemId: ids.usedMenu } },
        },
      });
      await prisma.diningTable.create({
        data: {
          id: catalog.tables[0].id,
          name: 'Demo Table 01',
          status: 'OCCUPIED',
        },
      });
      await prisma.kitchenStation.create({
        data: {
          id: catalog.stations[0].id,
          name: 'Demo Drinks',
          code: 'DEMO_DRINKS',
          prepSlaSeconds: 321,
        },
      });
      await prisma.fund.create({
        data: {
          id: ids.fund,
          name: 'Demo Cash',
          type: 'CASH',
          balance: '57000',
        },
      });
      const ledger = await prisma.inventoryTransaction.findUniqueOrThrow({
        where: { id: ids.transaction },
      });
      const before = {
        invoices: await prisma.invoice.count(),
        payments: await prisma.paymentAttempt.count(),
        cash: await prisma.cashTransaction.count(),
        inventory: await prisma.inventoryTransaction.count(),
      };
      await prisma.menuCategory.create({
        data: { ...catalog.categories[0], deletedAt: new Date() },
      });
      await expect(seedCatalog(prisma, 1, true)).rejects.toThrow(
        'Catalog references inactive data',
      );
      expect(
        await prisma.menuItem.findUnique({ where: { id: ids.unusedMenu } }),
      ).toMatchObject({ name: 'Demo Espresso', deletedAt: null });
      expect(
        await prisma.diningTable.findUnique({
          where: { id: catalog.tables[0].id },
        }),
      ).toMatchObject({ name: 'Demo Table 01', status: 'OCCUPIED' });
      expect(
        await prisma.fund.findUnique({ where: { id: ids.fund } }),
      ).toMatchObject({ name: 'Demo Cash' });
      await prisma.menuCategory.delete({
        where: { id: catalog.categories[0].id },
      });

      const result = await seedCatalog(prisma, 1, true);
      expect(result).toMatchObject({
        menuItems: 44,
        inventoryItems: 32,
        cleanup: {
          deletedMenuItems: 1,
          archivedMenuItems: 1,
          deletedInventoryItems: 1,
          archivedInventoryItems: 1,
          renamedTables: 1,
          renamedStations: 1,
          renamedFunds: 1,
        },
      });
      expect(
        await prisma.menuItem.findUnique({ where: { id: ids.unusedMenu } }),
      ).toBeNull();
      expect(
        await prisma.inventoryItem.findUnique({
          where: { id: ids.unusedInventory },
        }),
      ).toBeNull();
      expect(
        await prisma.menuItem.findUnique({ where: { id: ids.usedMenu } }),
      ).toMatchObject({ deletedAt: expect.any(Date), isAvailable: false });
      expect(
        await prisma.customerWishlist.count({
          where: { customerId: ids.customer },
        }),
      ).toBe(1);
      expect(
        await prisma.menuItem.findUnique({ where: { id: ids.unrelatedMenu } }),
      ).toMatchObject({ name: 'Demo Staff special', deletedAt: null });
      const stock = await prisma.inventoryItem.findUniqueOrThrow({
        where: { id: ids.inventory },
      });
      expect(stock.deletedAt).toBeInstanceOf(Date);
      expect(stock.stock.toString()).toBe('2.5');
      expect(stock.averageUnitCost.toString()).toBe('320000');
      expect(
        await prisma.inventoryTransaction.findUnique({
          where: { id: ids.transaction },
        }),
      ).toEqual(ledger);
      expect(
        await prisma.diningTable.findUnique({
          where: { id: catalog.tables[0].id },
        }),
      ).toMatchObject({ name: 'Bàn 01', status: 'OCCUPIED' });
      expect(
        await prisma.kitchenStation.findUnique({
          where: { id: catalog.stations[0].id },
        }),
      ).toMatchObject({
        name: 'Quầy pha chế',
        code: 'BAR',
        prepSlaSeconds: 321,
      });
      expect(
        (
          await prisma.fund.findUniqueOrThrow({ where: { id: ids.fund } })
        ).balance.toString(),
      ).toBe('57000');
      const replay = await seedCatalog(prisma, 999, true);
      expect(Object.values(replay.cleanup!).every((value) => value === 0)).toBe(
        true,
      );
      expect(replay.menuItems).toBe(0);
      expect(await prisma.invoice.count()).toBe(before.invoices);
      expect(await prisma.paymentAttempt.count()).toBe(before.payments);
      expect(await prisma.cashTransaction.count()).toBe(before.cash);
      expect(await prisma.inventoryTransaction.count()).toBe(before.inventory);
    } finally {
      await prisma.customer.deleteMany({ where: { id: ids.customer } });
      await prisma.menuItemIngredient.deleteMany({
        where: { menuItemId: { in: [ids.unusedMenu, ids.usedMenu] } },
      });
      await prisma.menuItem.deleteMany({
        where: {
          id: { in: [ids.unusedMenu, ids.usedMenu, ids.unrelatedMenu] },
        },
      });
      await prisma.inventoryTransaction.deleteMany({
        where: { id: ids.transaction },
      });
      await prisma.inventoryItem.deleteMany({
        where: { id: { in: [ids.inventory, ids.unusedInventory] } },
      });
      await prisma.inventoryCategory.deleteMany({
        where: { id: ids.inventoryCategory },
      });
      await prisma.unit.deleteMany({ where: { id: ids.unit } });
      await prisma.menuCategory.deleteMany({
        where: { id: { in: [ids.menuCategory, ids.unrelatedCategory] } },
      });
      await prisma.fund.deleteMany({ where: { id: ids.fund } });
    }
  });
});
