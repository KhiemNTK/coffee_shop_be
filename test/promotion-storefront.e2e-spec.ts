import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { PrismaClient } from '@prisma/client';
import {
  PrismaService,
  type ExtendedPrismaClient,
} from '../src/common/prisma/prisma.service';
import { PromotionsService } from '../src/app/promotions/promotions.service';
import { PromotionsRepository } from '../src/app/promotions/repositories/promotions.repository';
import { PromotionTransactionService } from '../src/app/promotions/services/promotion-transaction.service';
import { PromotionPolicyService } from '../src/app/promotions/policies/promotion-policy.service';
import { PromotionAuditService } from '../src/app/promotions/services/promotion-audit.service';

describe('Promotion publication (isolated PostgreSQL)', () => {
  const originalUrl = process.env.DATABASE_URL;
  const databaseName = `promotion_publication_${randomUUID().replaceAll('-', '')}_test`;
  let admin: PrismaClient;
  let base: PrismaService;
  let db: ExtendedPrismaClient;
  let service: PromotionsService;
  let actorId: string;
  let created = false;

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
    const repository = new PromotionsRepository(db);
    service = new PromotionsService(
      repository,
      new PromotionPolicyService(),
      new PromotionTransactionService(repository),
      new PromotionAuditService(),
      {} as never,
    );
    const position = await db.position.create({
      data: { name: 'Publication operator', salary: 0 },
    });
    const employee = await db.employee.create({
      data: {
        email: 'publication@example.test',
        username: 'publication',
        password: 'not-a-login',
        fullName: 'Publication operator',
        positionId: position.id,
      },
    });
    actorId = employee.id;
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

  beforeEach(async () => {
    await db.promotion.updateMany({
      where: { deletedAt: null },
      data: { showOnStorefront: false },
    });
  });

  const create = (overrides: Record<string, unknown> = {}) =>
    db.promotion.create({
      data: {
        name: randomUUID(),
        discountType: 'PERCENTAGE',
        discountValue: '12.50',
        maxDiscount: '45000',
        startDate: new Date(Date.now() - 60_000),
        endDate: new Date(Date.now() + 3600_000),
        ...overrides,
      },
    });

  it('keeps existing/new promotions private and exposes only an active minimal projection', async () => {
    await create();
    await create({
      showOnStorefront: true,
      endDate: new Date(Date.now() - 1),
      startDate: new Date(Date.now() - 120_000),
    });
    await create({
      showOnStorefront: true,
      startDate: new Date(Date.now() + 60_000),
    });
    await create({ showOnStorefront: true, deletedAt: new Date() });
    expect(await service.findStorefrontPromotion()).toEqual({
      promotion: null,
    });
    const visible = await create({
      showOnStorefront: true,
      storefrontDescription: 'Only at the counter',
    });
    const { promotion } = await service.findStorefrontPromotion();
    expect(promotion).toEqual({
      id: visible.id,
      name: visible.name,
      startDate: visible.startDate,
      endDate: visible.endDate,
      discountType: 'PERCENTAGE',
      discountValue: '12.5',
      maxDiscount: '45000',
      storefrontDescription: 'Only at the counter',
    });
  });

  it('atomically publishes with audit and rejects stale/concurrent writes', async () => {
    const promotion = await create();
    const payload = {
      showOnStorefront: true,
      storefrontDescription: 'Public copy',
      expectedUpdatedAt: promotion.updatedAt,
    };
    const results = await Promise.allSettled([
      service.updateStorefront(promotion.id, actorId, payload),
      service.updateStorefront(promotion.id, actorId, payload),
    ]);
    expect(
      results.filter((result) => result.status === 'fulfilled'),
    ).toHaveLength(1);
    const rejection = results.find(
      (result) => result.status === 'rejected',
    ) as PromiseRejectedResult;
    expect(rejection.reason.getResponse().code).toBe(
      'PROMOTION_STOREFRONT_CHANGED',
    );
    expect(
      await db.actionLog.count({
        where: { actionType: 'PROMOTION_STOREFRONT_UPDATED' },
      }),
    ).toBe(1);
    expect((await service.findStorefrontPromotion()).promotion?.id).toBe(
      promotion.id,
    );
  });

  it('allows unpublishing expired promotions but never publishing them', async () => {
    const promotion = await create({
      showOnStorefront: true,
      startDate: new Date(Date.now() - 120_000),
      endDate: new Date(Date.now() - 1),
    });
    await expect(
      service.updateStorefront(promotion.id, actorId, {
        showOnStorefront: true,
        storefrontDescription: null,
        expectedUpdatedAt: promotion.updatedAt,
      }),
    ).rejects.toMatchObject({ response: { code: 'PROMOTION_EXPIRED' } });
    await service.updateStorefront(promotion.id, actorId, {
      showOnStorefront: false,
      storefrontDescription: null,
      expectedUpdatedAt: promotion.updatedAt,
    });
    expect(
      (await db.promotion.findUniqueOrThrow({ where: { id: promotion.id } }))
        .showOnStorefront,
    ).toBe(false);
  });

  it('rolls back publication if the audit write fails', async () => {
    const promotion = await create();
    const repository = new PromotionsRepository(db);
    const failing = new PromotionsService(
      repository,
      new PromotionPolicyService(),
      new PromotionTransactionService(repository),
      {
        log: () => Promise.reject(new Error('audit unavailable')),
      },
      {} as never,
    );
    await expect(
      failing.updateStorefront(promotion.id, actorId, {
        showOnStorefront: true,
        storefrontDescription: null,
        expectedUpdatedAt: promotion.updatedAt,
      }),
    ).rejects.toThrow('audit unavailable');
    expect(
      (await db.promotion.findUniqueOrThrow({ where: { id: promotion.id } }))
        .showOnStorefront,
    ).toBe(false);
  });

  it('does not republish on restore and rejects inactive employees', async () => {
    const promotion = await create({ showOnStorefront: true });
    await service.remove(promotion.id, actorId);
    await service.restore(promotion.id, actorId);
    expect(
      (await db.promotion.findUniqueOrThrow({ where: { id: promotion.id } }))
        .showOnStorefront,
    ).toBe(false);
    await db.employee.update({
      where: { id: actorId },
      data: { isActive: false },
    });
    try {
      await expect(
        service.updateStorefront(promotion.id, actorId, {
          showOnStorefront: true,
          storefrontDescription: null,
          expectedUpdatedAt: promotion.updatedAt,
        }),
      ).rejects.toThrow('inactive');
    } finally {
      await db.employee.update({
        where: { id: actorId },
        data: { isActive: true },
      });
    }
  });
});
