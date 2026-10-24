import { CatchEverythingFilter } from './catch-everything.filter';
import { AutoMockingModule } from '../../test/auto-mocking/auto-mocking.module';
import { ConflictException } from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import { ExecutionContextHost } from '@nestjs/core/helpers/execution-context-host';
import { ExpressAdapter } from '@nestjs/platform-express';
import express from 'express';
import request from 'supertest';
import { httpLocaleMiddleware } from '../common/i18n/http-locale';
import { ZodExceptionService } from './zod-exception/zod-exception.service';

describe('CatchEverythingFilter', () => {
  let filter: CatchEverythingFilter;

  beforeEach(async () => {
    const module = await AutoMockingModule.createTestingModule({
      providers: [CatchEverythingFilter],
    });

    filter = module.get<CatchEverythingFilter>(CatchEverythingFilter);
  });

  it('should be defined', () => {
    expect(filter).toBeDefined();
  });

  it.each(['valid', 'malformed', 'unrelated'])(
    'only exposes validated daily-close counts: %s',
    async (scenario) => {
      const adapter = new HttpAdapterHost();
      adapter.httpAdapter = new ExpressAdapter();
      const actualFilter = new CatchEverythingFilter(
        adapter,
        new ZodExceptionService(),
      );
      const blockers = {
        openShifts: 1,
        unpaidInvoices: 0,
        unfinishedItems: 0,
        uncertainPayments: 0,
        uncertainRefunds: 2,
        openIncidents: 0,
      };
      const app = express().use(httpLocaleMiddleware);
      app.get('/close', (req, res) => {
        actualFilter.catch(
          new ConflictException({
            code: scenario === 'unrelated' ? 'HTTP_409' : 'DAILY_CLOSE_BLOCKED',
            message: 'Unfinished operations.',
            blockers: {
              ...blockers,
              openShifts: scenario === 'malformed' ? -1 : blockers.openShifts,
              secret: 'must-not-leak',
            },
            internalData: 'must-not-leak',
          }),
          new ExecutionContextHost([req, res]),
        );
      });
      const result = await request(app)
        .get('/close')
        .set('Accept-Language', 'en')
        .expect(409);
      expect(result.body.details).toEqual(
        scenario === 'valid' ? { blockers } : undefined,
      );
      expect(JSON.stringify(result.body)).not.toContain('must-not-leak');
    },
  );

  it.each(['vi', 'en'])(
    'keeps the response contract while translating %s errors',
    async (locale) => {
      const adapter = new HttpAdapterHost();
      adapter.httpAdapter = new ExpressAdapter();
      const actualFilter = new CatchEverythingFilter(
        adapter,
        new ZodExceptionService(),
      );
      const app = express().use(httpLocaleMiddleware);
      app.get('/conflict', (req, res) => {
        Object.assign(req, { requestId: 'locale-contract-test' });
        actualFilter.catch(
          new ConflictException({
            code: 'INVENTORY_UNIT_IMMUTABLE',
            message: 'A unit cannot be changed.',
          }),
          new ExecutionContextHost([req, res]),
        );
      });
      const result = await request(app)
        .get('/conflict')
        .set('Accept-Language', locale)
        .expect(409);
      expect(result.body).toEqual({
        data: null,
        message: 'ERROR',
        code: 'INVENTORY_UNIT_IMMUTABLE',
        requestId: 'locale-contract-test',
        errors: [
          {
            message:
              locale === 'vi'
                ? 'Không thể đổi đơn vị tính của nguyên liệu đã tạo.'
                : 'A unit cannot be changed.',
          },
        ],
      });
      expect(result.headers['content-language']).toBe(locale);
    },
  );
});
