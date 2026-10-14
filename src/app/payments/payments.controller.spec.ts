import {
  Controller,
  Post,
  ServiceUnavailableException,
  UseGuards,
  type INestApplication,
} from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import {
  SkipThrottle,
  Throttle,
  ThrottlerGuard,
  ThrottlerModule,
  ThrottlerStorageService,
} from '@nestjs/throttler';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types';
import { FormatResponseInterceptor } from '../../common/interceptors/format-response/format-response.interceptor';
import { ApiUtilService } from '../../common/utils/api-util/api-util.service';
import { PaymentReconciliationService } from './payment-reconciliation.service';
import { PaymentRefundsService } from './payment-refunds.service';
import { PaymentsController } from './payments.controller';
import { PaymentsService } from './payments.service';
import { PaymentWebhookGuard } from './payment-webhook.guard';
import { HealthController } from '../health/health.controller';
import { HealthService } from '../health/health.service';

@Controller('test-callback')
@SkipThrottle()
@UseGuards(PaymentWebhookGuard)
class LimitedCallbackController {
  @Post()
  @Throttle({ 'payment-webhook': { limit: 2, ttl: 60_000 } })
  accept() {
    return { ok: true };
  }
}

describe('PaymentsController', () => {
  let app: INestApplication<App>;
  const paymentsService = {
    handleVnpayIpn: jest.fn(),
    handleMomoIpn: jest.fn(),
    handlePayosWebhook: jest.fn(),
  };
  const redisIncrement = jest
    .fn()
    .mockRejectedValue(
      new ServiceUnavailableException({ code: 'RATE_LIMIT_UNAVAILABLE' }),
    );

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      imports: [
        ThrottlerModule.forRoot({
          throttlers: [{ ttl: 60_000, limit: 100 }],
          storage: { increment: redisIncrement },
        }),
      ],
      controllers: [
        PaymentsController,
        HealthController,
        LimitedCallbackController,
      ],
      providers: [
        { provide: PaymentsService, useValue: paymentsService },
        { provide: PaymentRefundsService, useValue: {} },
        { provide: PaymentReconciliationService, useValue: {} },
        ApiUtilService,
        ThrottlerStorageService,
        PaymentWebhookGuard,
        { provide: APP_GUARD, useClass: ThrottlerGuard },
        {
          provide: HealthService,
          useValue: {
            liveness: () => ({ status: 'ok' }),
            readiness: () => {
              throw new ServiceUnavailableException({
                code: 'SERVICE_NOT_READY',
              });
            },
          },
        },
      ],
    }).compile();
    app = module.createNestApplication();
    app.useGlobalInterceptors(
      new FormatResponseInterceptor(module.get(ApiUtilService)),
    );
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('returns the raw VNPay acknowledgement without the API envelope', async () => {
    paymentsService.handleVnpayIpn.mockResolvedValue({
      RspCode: '00',
      Message: 'Confirm Success',
    });

    await request(app.getHttpServer())
      .get('/payments/vnpay/ipn?vnp_TxnRef=PA123')
      .expect(200)
      .expect({ RspCode: '00', Message: 'Confirm Success' });
  });

  it('acknowledges MoMo IPN with HTTP 204 and no response body', async () => {
    paymentsService.handleMomoIpn.mockResolvedValue(undefined);

    await request(app.getHttpServer())
      .post('/payments/momo/ipn')
      .send({ orderId: 'PA123' })
      .expect(204)
      .expect('');
    expect(paymentsService.handleMomoIpn).toHaveBeenCalledWith({
      orderId: 'PA123',
    });
  });

  it('acknowledges payOS without using the unavailable Redis limiter', async () => {
    redisIncrement.mockClear();
    paymentsService.handlePayosWebhook.mockResolvedValue(undefined);
    await request(app.getHttpServer())
      .post('/payments/payos/webhook')
      .send({})
      .expect(200);
    expect(paymentsService.handlePayosWebhook).toHaveBeenCalled();
    expect(redisIncrement).not.toHaveBeenCalled();
  });

  it('keeps liveness up, readiness at 503 and ordinary routes fail-closed', async () => {
    redisIncrement.mockClear();
    await request(app.getHttpServer()).get('/health/live').expect(200);
    await request(app.getHttpServer()).get('/health/ready').expect(503);
    expect(redisIncrement).not.toHaveBeenCalled();
    await request(app.getHttpServer()).get('/payments/providers').expect(503);
    expect(redisIncrement).toHaveBeenCalledTimes(1);
  });

  it('still enforces the named callback limit when the global limiter is skipped', async () => {
    redisIncrement.mockClear();
    await request(app.getHttpServer()).post('/test-callback').expect(201);
    await request(app.getHttpServer()).post('/test-callback').expect(201);
    await request(app.getHttpServer()).post('/test-callback').expect(429);
    expect(redisIncrement).not.toHaveBeenCalled();
  });
});
