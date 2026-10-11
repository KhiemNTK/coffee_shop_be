import { createHash, randomUUID } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { ThrottlerGuard } from '@nestjs/throttler';
import {
  OnlineOrderStatus,
  PaymentAttemptStatus,
  PaymentRefundStatus,
  PaymentStatus,
  ServeStatus,
} from '@prisma/client';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from '../src/app/app.module';
import { RecommendationsService } from '../src/app/recommendations/recommendations.service';
import { PrismaService } from '../src/common/prisma/prisma.service';
import { initApp } from '../src/init';

describe('Online item recommendations (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let recommendations: RecommendationsService;
  let throttleSpy: jest.SpyInstance;
  let prefix: string;
  const suffix = randomUUID();
  const sessions: string[] = [];
  const invoices: string[] = [];
  const clients: string[] = [];
  const ids: Record<string, string> = {};

  const createPaymentAttempt = (invoiceId: string) => {
    const id = randomUUID();
    return prisma.paymentAttempt.create({
      data: {
        invoiceId,
        status: PaymentAttemptStatus.SUCCEEDED,
        amount: 35_000,
        merchantReference: id,
        providerTransactionNo: id,
        idempotencyKey: id,
        requestHash: 'a'.repeat(64),
        expiresAt: new Date(Date.now() + 60_000),
        completedAt: new Date(),
        createdById: ids.employee,
        shiftId: ids.shift,
      },
    });
  };

  const createRefund = (
    paymentAttemptId: string,
    amount: number,
    status: PaymentRefundStatus,
  ) => {
    const id = randomUUID();
    return prisma.paymentRefund.create({
      data: {
        paymentAttemptId,
        requestedById: ids.employee,
        type: amount === 35_000 ? 'FULL' : 'PARTIAL',
        status,
        amount,
        reason: 'Recommendation test refund',
        idempotencyKey: id,
        requestHash: 'b'.repeat(64),
        providerRequestId: id,
        completedAt:
          status === PaymentRefundStatus.SUCCEEDED ||
          status === PaymentRefundStatus.FAILED ||
          status === PaymentRefundStatus.REJECTED
            ? new Date()
            : null,
      },
    });
  };

  beforeAll(async () => {
    throttleSpy = jest
      .spyOn(ThrottlerGuard.prototype, 'canActivate')
      .mockResolvedValue(true);
    const module = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    const expressApp = module.createNestApplication<NestExpressApplication>();
    initApp(expressApp);
    app = expressApp;
    prisma = module.get(PrismaService);
    recommendations = module.get(RecommendationsService);
    prefix = module.get(ConfigService).get<string>('APP_PREFIX', '/api/v1');
    await app.init();

    ids.position = (
      await prisma.position.create({
        data: { name: `Recommendation position ${suffix}`, salary: 0 },
      })
    ).id;
    ids.employee = (
      await prisma.employee.create({
        data: {
          email: `recommend-${suffix}@example.com`,
          username: `recommend-${suffix}`,
          fullName: 'Recommendation test',
          password: 'test-only',
          positionId: ids.position,
        },
      })
    ).id;
    ids.shift = (
      await prisma.cashierShift.create({
        data: { employeeId: ids.employee, startingCash: 0 },
      })
    ).id;
    ids.category = (
      await prisma.menuCategory.create({
        data: { name: `Recommendation category ${suffix}` },
      })
    ).id;
    ids.anchor = (
      await prisma.menuItem.create({
        data: {
          name: `Anchor ${suffix}`,
          price: 25_000,
          categoryId: ids.category,
        },
      })
    ).id;
    ids.candidate = (
      await prisma.menuItem.create({
        data: {
          name: `Candidate ${suffix}`,
          price: 10_000,
          categoryId: ids.category,
        },
      })
    ).id;

    const paymentStatuses = [
      PaymentStatus.PAID,
      PaymentStatus.PAID,
      PaymentStatus.PARTIALLY_REFUNDED,
      PaymentStatus.REFUNDED,
      PaymentStatus.PAID,
      PaymentStatus.UNPAID,
      PaymentStatus.VOIDED,
    ];
    for (const [index, paymentStatus] of paymentStatuses.entries()) {
      const session = await prisma.orderSession.create({
        data: { employeeId: ids.employee },
      });
      sessions.push(session.id);
      const invoice = await prisma.invoice.create({
        data: {
          invoiceNumber: `REC-${suffix}-${index}`,
          orderSessionId: session.id,
          employeeId: ids.employee,
          subTotal: 35_000,
          totalAmount: 35_000,
          paymentStatus,
        },
      });
      invoices.push(invoice.id);
      await prisma.orderItem.createMany({
        data: [ids.anchor, ids.candidate].map((menuItemId) => ({
          menuItemId,
          orderSessionId: session.id,
          invoiceId: invoice.id,
          quantity: 1,
          priceAtTime: menuItemId === ids.anchor ? 25_000 : 10_000,
          serveStatus:
            index === 4 && menuItemId === ids.candidate
              ? ServeStatus.CANCELLED
              : ServeStatus.SERVED,
          isPaid:
            paymentStatus !== PaymentStatus.UNPAID &&
            paymentStatus !== PaymentStatus.VOIDED,
        })),
      });
      if (index === 2 || index === 3) {
        const attempt = await createPaymentAttempt(invoice.id);
        await createRefund(
          attempt.id,
          index === 2 ? 5_000 : 35_000,
          PaymentRefundStatus.SUCCEEDED,
        );
      }
    }
  });

  afterAll(async () => {
    try {
      await prisma.recommendationExposure.deleteMany({
        where: { clientRequestId: { in: clients } },
      });
      await prisma.onlineOrderRequest.deleteMany({
        where: { clientRequestId: { in: clients } },
      });
      await prisma.orderItem.deleteMany({
        where: { orderSessionId: { in: sessions } },
      });
      await prisma.paymentRefund.deleteMany({
        where: { paymentAttempt: { invoiceId: { in: invoices } } },
      });
      await prisma.paymentAttempt.deleteMany({
        where: { invoiceId: { in: invoices } },
      });
      await prisma.invoice.deleteMany({ where: { id: { in: invoices } } });
      await prisma.orderSession.deleteMany({ where: { id: { in: sessions } } });
      if (ids.shift) {
        await prisma.cashierShift.delete({ where: { id: ids.shift } });
      }
      await prisma.menuItem.deleteMany({
        where: { id: { in: [ids.anchor, ids.candidate] } },
      });
      await prisma.menuCategory.deleteMany({ where: { id: ids.category } });
      await prisma.employee.deleteMany({ where: { id: ids.employee } });
      await prisma.position.deleteMany({ where: { id: ids.position } });
    } finally {
      await app?.close();
      throttleSpy?.mockRestore();
    }
  });

  it('trains on paid and partial-refund purchases, assigns stable cohorts and counts attachment', async () => {
    const from = new Date(Date.now() - 10_000);
    expect(await recommendations.refreshPairs(true)).toBe(true);
    expect(
      await prisma.menuItemRecommendationPair.findUnique({
        where: {
          anchorId_candidateId: {
            anchorId: ids.anchor,
            candidateId: ids.candidate,
          },
        },
      }),
    ).toMatchObject({ support: 3 });

    const posSession = await prisma.orderSession.create({
      data: { employeeId: ids.employee },
    });
    sessions.push(posSession.id);
    await prisma.orderItem.create({
      data: {
        menuItemId: ids.anchor,
        orderSessionId: posSession.id,
        quantity: 1,
        priceAtTime: 25_000,
      },
    });
    expect(await recommendations.recommendPos(posSession.id)).toMatchObject({
      recommendations: [{ menuItemId: ids.candidate, price: '10000.00' }],
    });
    await request(app.getHttpServer())
      .get(`${prefix}/recommendations/pos/${posSession.id}`)
      .expect(401);

    const clientFor = (treatment: boolean) => {
      while (true) {
        const id = randomUUID();
        if (
          (createHash('sha256').update(id).digest()[0] % 2 === 1) ===
          treatment
        )
          return id;
      }
    };
    const treatment = clientFor(true);
    const control = clientFor(false);
    clients.push(treatment, control);
    const body = { clientRequestId: treatment, menuItemIds: [ids.anchor] };

    const [first, concurrent] = await Promise.all([
      request(app.getHttpServer())
        .post(`${prefix}/recommendations/online`)
        .send(body)
        .expect(200),
      request(app.getHttpServer())
        .post(`${prefix}/recommendations/online`)
        .send(body)
        .expect(200),
    ]);
    expect(concurrent.body.data).toEqual(first.body.data);
    expect(first.body.data).toMatchObject({
      variant: 'TREATMENT',
      recommendations: [{ menuItemId: ids.candidate, price: '10000.00' }],
    });
    expect(
      (
        await request(app.getHttpServer())
          .post(`${prefix}/recommendations/online`)
          .send(body)
          .expect(200)
      ).body.data,
    ).toEqual(first.body.data);
    await request(app.getHttpServer())
      .post(`${prefix}/recommendations/online`)
      .send({ clientRequestId: treatment, menuItemIds: [ids.candidate] })
      .expect(409);

    const controlResponse = await request(app.getHttpServer())
      .post(`${prefix}/recommendations/online`)
      .send({ clientRequestId: control, menuItemIds: [ids.anchor] })
      .expect(200);
    expect(controlResponse.body.data).toEqual({
      variant: 'CONTROL',
      recommendations: [],
    });

    await prisma.menuItem.update({
      where: { id: ids.candidate },
      data: { isAvailable: false },
    });
    expect(
      (
        await request(app.getHttpServer())
          .post(`${prefix}/recommendations/online`)
          .send(body)
          .expect(200)
      ).body.data.recommendations,
    ).toEqual([]);
    await prisma.menuItem.update({
      where: { id: ids.candidate },
      data: { isAvailable: true, price: 12_000 },
    });
    expect(
      (
        await request(app.getHttpServer())
          .post(`${prefix}/recommendations/online`)
          .send(body)
          .expect(200)
      ).body.data.recommendations[0].price,
    ).toBe('12000.00');

    await prisma.onlineOrderRequest.create({
      data: {
        clientRequestId: treatment,
        requestHash: 'a'.repeat(64),
        pickupName: 'Test only',
        phoneNumber: '0901234567',
        quotedSubtotal: 35_000,
        expiresAt: new Date(Date.now() + 60_000),
        status: OnlineOrderStatus.ACCEPTED,
        reviewedAt: new Date(),
        reviewedById: ids.employee,
        orderSessionId: sessions[0],
      },
    });
    const report = await recommendations.getExperiment(
      from,
      new Date(Date.now() + 1_000),
    );
    expect(
      report.variants.find((item) => item.variant === 'TREATMENT'),
    ).toMatchObject({
      assignments: 1,
      offersWithCandidates: 1,
      requests: 1,
      paidOrders: 1,
      attachedOrders: 1,
      revenue: '35000.00',
    });
    expect(
      report.variants.find((item) => item.variant === 'CONTROL'),
    ).toMatchObject({
      assignments: 1,
      offersWithCandidates: 0,
      requests: 0,
      paidOrders: 0,
    });
    const lateClient = randomUUID();
    clients.push(lateClient);
    await prisma.onlineOrderRequest.create({
      data: {
        clientRequestId: lateClient,
        requestHash: 'b'.repeat(64),
        pickupName: 'Late test',
        phoneNumber: '0901234567',
        quotedSubtotal: 25_000,
        expiresAt: new Date(Date.now() + 60_000),
      },
    });
    await request(app.getHttpServer())
      .post(`${prefix}/recommendations/online`)
      .send({ clientRequestId: lateClient, menuItemIds: [ids.anchor] })
      .expect(409);
    await request(app.getHttpServer())
      .get(
        `${prefix}/recommendations/experiment?from=${from.toISOString()}&to=${new Date().toISOString()}`,
      )
      .expect(401);
  });

  it('keeps purchase conversion and attachment stable while successful refunds restate net revenue', async () => {
    const from = new Date(Date.now() - 24 * 60 * 60 * 1_000);
    const to = new Date(from.getTime() + 1);
    for (const index of [1, 4, 5, 6]) {
      const clientRequestId = randomUUID();
      clients.push(clientRequestId);
      await prisma.recommendationExposure.create({
        data: {
          clientRequestId,
          basketHash: 'c'.repeat(64),
          variant: 'TREATMENT',
          candidateIds: [ids.candidate],
          createdAt: from,
        },
      });
      await prisma.onlineOrderRequest.create({
        data: {
          clientRequestId,
          requestHash: 'd'.repeat(64),
          pickupName: 'Refund metrics test',
          phoneNumber: '0901234567',
          quotedSubtotal: 35_000,
          expiresAt: new Date(Date.now() + 60_000),
          status: OnlineOrderStatus.ACCEPTED,
          reviewedAt: new Date(),
          reviewedById: ids.employee,
          orderSessionId: sessions[index],
        },
      });
    }
    const attempt = await createPaymentAttempt(invoices[1]);
    for (const status of [
      PaymentRefundStatus.PENDING,
      PaymentRefundStatus.PROCESSING,
      PaymentRefundStatus.FAILED,
      PaymentRefundStatus.REJECTED,
      PaymentRefundStatus.REQUIRES_REVIEW,
    ]) {
      await createRefund(attempt.id, 1_000, status);
    }
    const expectMetrics = async (
      revenue: string,
      average: string,
      perAssignment: string,
    ) => {
      const report = await recommendations.getExperiment(from, to);
      expect(report.variants[1]).toEqual({
        variant: 'TREATMENT',
        assignments: 4,
        offersWithCandidates: 4,
        requests: 4,
        paidOrders: 2,
        attachedOrders: 1,
        revenue,
        paidConversionRate: 0.5,
        attachedPaidOrderRate: 0.5,
        revenuePerAssignment: perAssignment,
        averageOrderValue: average,
      });
    };

    await expectMetrics('70000.00', '35000.00', '17500.00');
    await createRefund(attempt.id, 2_500, PaymentRefundStatus.SUCCEEDED);
    await createRefund(attempt.id, 7_500, PaymentRefundStatus.SUCCEEDED);
    await prisma.invoice.update({
      where: { id: invoices[1] },
      data: { paymentStatus: PaymentStatus.PARTIALLY_REFUNDED },
    });
    await expectMetrics('60000.00', '30000.00', '15000.00');

    await createRefund(attempt.id, 25_000, PaymentRefundStatus.SUCCEEDED);
    await prisma.invoice.update({
      where: { id: invoices[1] },
      data: { paymentStatus: PaymentStatus.REFUNDED },
    });
    await expectMetrics('35000.00', '17500.00', '8750.00');
  });
});
