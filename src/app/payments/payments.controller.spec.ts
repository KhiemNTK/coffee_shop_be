import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types';
import { FormatResponseInterceptor } from '../../common/interceptors/format-response/format-response.interceptor';
import { ApiUtilService } from '../../common/utils/api-util/api-util.service';
import { PaymentsController } from './payments.controller';
import { PaymentsService } from './payments.service';

describe('PaymentsController', () => {
  let app: INestApplication<App>;
  const paymentsService = {
    handleVnpayIpn: jest.fn(),
  };

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      controllers: [PaymentsController],
      providers: [
        { provide: PaymentsService, useValue: paymentsService },
        ApiUtilService,
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
});
