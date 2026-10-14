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
import { buildDemoData, seedDemo } from '../prisma/demo-data';

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

  const clearDemoFixtures = async () => {
    const demo = buildDemoData(1);
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
      await tx.fund.deleteMany({ where: { id: demo.fund.id } });
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
        await clearDemoFixtures();
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

  it('seeds valid linked catalog/stock once and never overwrites user edits or restocks on replay', async () => {
    await clearDemoFixtures();
    const before = {
      invoices: await prisma.invoice.count(),
      payments: await prisma.paymentAttempt.count(),
    };
    const inserted = await seedDemo(prisma, 1);
    expect(inserted).toMatchObject({
      menuItems: 24,
      inventoryItems: 8,
      tables: 6,
    });
    const demo = buildDemoData(1);
    const stock = demo.inventoryItems[0];
    await prisma.$transaction(async (tx) => {
      await tx.inventoryItem.update({
        where: { id: stock.id },
        data: { stock: { decrement: 1 } },
      });
      await tx.inventoryTransaction.create({
        data: {
          inventoryItemId: stock.id,
          type: 'EXPORT',
          quantity: 1,
          unitPrice: stock.averageUnitCost,
          totalAmount: stock.averageUnitCost,
          transactionDate: new Date(),
        },
      });
    });
    await prisma.menuItem.update({
      where: { id: demo.menuItems[0].id },
      data: { name: 'Edited demo name', price: '49999' },
    });
    expect(await seedDemo(prisma, 999)).toEqual({
      units: 0,
      inventoryItems: 0,
      menuCategories: 0,
      menuItems: 0,
      tables: 0,
    });
    expect(
      (
        await prisma.inventoryItem.findUniqueOrThrow({
          where: { id: stock.id },
        })
      ).stock.equals(stock.stock.minus(1)),
    ).toBe(true);
    expect(
      (
        await prisma.menuItem.findUniqueOrThrow({
          where: { id: demo.menuItems[0].id },
        })
      ).name,
    ).toBe('Edited demo name');
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
    ).toBe(Number(stock.stock.minus(1)));
    expect(await prisma.invoice.count()).toBe(before.invoices);
    expect(await prisma.paymentAttempt.count()).toBe(before.payments);
  });
});
