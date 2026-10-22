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
