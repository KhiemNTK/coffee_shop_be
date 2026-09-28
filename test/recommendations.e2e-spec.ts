import { createHash, randomUUID } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { ThrottlerGuard } from '@nestjs/throttler';
import { OnlineOrderStatus, PaymentStatus, ServeStatus } from '@prisma/client';
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

    for (let index = 0; index < 4; index++) {
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
          paymentStatus:
            index === 3 ? PaymentStatus.REFUNDED : PaymentStatus.PAID,
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
          serveStatus: ServeStatus.SERVED,
          isPaid: true,
        })),
      });
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
      await prisma.invoice.deleteMany({ where: { id: { in: invoices } } });
      await prisma.orderSession.deleteMany({ where: { id: { in: sessions } } });
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

  it('builds paid-order pairs, assigns stable cohorts and counts paid attachment', async () => {
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
});
