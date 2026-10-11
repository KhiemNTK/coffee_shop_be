import { Prisma } from '@prisma/client';
import { RecommendationsService } from './recommendations.service';
import {
  PUBLIC_MENU_SELECT,
  PUBLIC_MENU_WHERE,
} from '../menu/public-menu-query';

describe('Recommendation public contract', () => {
  it('returns current public options in candidate order without leaking recipes', async () => {
    const item = {
      id: 'candidate',
      name: 'Cake',
      price: new Prisma.Decimal('12000.25'),
      category: { id: 'category', name: 'Food' },
      optionGroups: [
        {
          id: 'group',
          name: 'Size',
          minSelected: 1,
          maxSelected: 1,
          options: [
            {
              id: 'option',
              name: 'Large',
              priceDelta: new Prisma.Decimal('3000.50'),
            },
          ],
        },
      ],
    };
    const prisma = {
      orderSession: {
        findUnique: jest.fn().mockResolvedValue({
          sessionStatus: 'ACTIVE',
          orderItems: [{ menuItemId: 'anchor' }],
        }),
      },
      menuItemRecommendationPair: {
        findMany: jest.fn().mockResolvedValue([
          { candidateId: 'unavailable', support: 5 },
          { candidateId: 'candidate', support: 3 },
        ]),
      },
      menuItem: { findMany: jest.fn().mockResolvedValue([item]) },
    };
    const service = new RecommendationsService(prisma as never);
    expect(await service.recommendPos('session')).toEqual({
      recommendations: [
        {
          ...item,
          menuItemId: item.id,
          price: '12000.25',
        },
      ],
    });
    expect(prisma.menuItem.findMany).toHaveBeenLastCalledWith({
      where: { ...PUBLIC_MENU_WHERE, id: { in: ['candidate'] } },
      select: PUBLIC_MENU_SELECT,
    });
    expect(PUBLIC_MENU_SELECT).not.toHaveProperty('ingredients');
    expect(
      PUBLIC_MENU_SELECT.optionGroups.select.options.select,
    ).not.toHaveProperty('ingredients');
  });
});

describe('Recommendation refund semantics', () => {
  it('trains on paid and partially refunded invoices, excluding cancelled lines', async () => {
    const tx = {
      $queryRaw: jest.fn().mockResolvedValue([{ locked: true }]),
      $executeRaw: jest.fn().mockResolvedValue(0),
      menuItemRecommendationPair: {
        deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
      },
      recommendationExposure: {
        deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
      },
    };
    const prisma = {
      $transaction: jest.fn(
        (callback: (client: typeof tx) => Promise<boolean>) => callback(tx),
      ),
    };
    const service = new RecommendationsService(prisma as never);

    expect(await service.refreshPairs(true)).toBe(true);

    const sql = tx.$executeRaw.mock.calls[0][0].join(' ');
    expect(sql).toContain(
      `i."paymentStatus" IN ('PAID', 'PARTIALLY_REFUNDED')`,
    );
    expect(sql).not.toContain(`'REFUNDED'`);
    expect(sql).toContain(`oi."serveStatus" <> 'CANCELLED'`);
    expect(sql).toContain('SELECT DISTINCT oi."invoiceId", oi."menuItemId"');
  });

  it('keeps purchase counts separate from net revenue and uses it for averages', async () => {
    const prisma = {
      $queryRaw: jest.fn().mockResolvedValue([
        {
          variant: 'TREATMENT',
          assignments: 4n,
          offersWithCandidates: 4n,
          requests: 3n,
          paidOrders: 3n,
          attachedOrders: 2n,
          revenue: new Prisma.Decimal('50000.25'),
        },
      ]),
    };
    const service = new RecommendationsService(prisma as never);
    const report = await service.getExperiment(
      new Date(Date.now() - 60_000),
      new Date(),
    );

    expect(report.variants).toEqual([
      {
        variant: 'CONTROL',
        assignments: 0,
        offersWithCandidates: 0,
        requests: 0,
        paidOrders: 0,
        attachedOrders: 0,
        revenue: '0.00',
        paidConversionRate: 0,
        attachedPaidOrderRate: 0,
        revenuePerAssignment: '0.00',
        averageOrderValue: '0.00',
      },
      {
        variant: 'TREATMENT',
        assignments: 4,
        offersWithCandidates: 4,
        requests: 3,
        paidOrders: 3,
        attachedOrders: 2,
        revenue: '50000.25',
        paidConversionRate: 0.75,
        attachedPaidOrderRate: 2 / 3,
        revenuePerAssignment: '12500.06',
        averageOrderValue: '16666.75',
      },
    ]);

    const sql = prisma.$queryRaw.mock.calls[0][0].sql;
    expect(sql).toContain('FROM "CashRefund"');
    expect(
      sql.match(
        /i\."paymentStatus" IN \('PAID', 'PARTIALLY_REFUNDED', 'REFUNDED'\)/g,
      ),
    ).toHaveLength(2);
    expect(sql).toContain(`oi."serveStatus" <> 'CANCELLED'`);
    expect(sql).toContain(`e."candidateIds" ? oi."menuItemId"`);
    expect(sql).toContain(`pr."status" = 'SUCCEEDED'`);
    expect(sql).toContain(`pa."id" = pr."paymentAttemptId"`);
    expect(sql).toContain(`pr."invoiceId" = i."id"`);
    expect(sql).toContain(`i."totalAmount" - COALESCE(refunds."amount", 0)`);
  });

  it('retains conversion and purchase attachment when net receipts are zero', async () => {
    const prisma = {
      $queryRaw: jest.fn().mockResolvedValue([
        {
          variant: 'TREATMENT',
          assignments: 1n,
          offersWithCandidates: 1n,
          requests: 1n,
          paidOrders: 1n,
          attachedOrders: 1n,
          revenue: new Prisma.Decimal(0),
        },
      ]),
    };
    const service = new RecommendationsService(prisma as never);
    const report = await service.getExperiment(
      new Date(Date.now() - 60_000),
      new Date(),
    );

    expect(report.variants[1]).toMatchObject({
      paidOrders: 1,
      attachedOrders: 1,
      revenue: '0.00',
      paidConversionRate: 1,
      attachedPaidOrderRate: 1,
      revenuePerAssignment: '0.00',
      averageOrderValue: '0.00',
    });
  });
});
