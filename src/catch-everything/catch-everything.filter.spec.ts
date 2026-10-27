import { CatchEverythingFilter } from './catch-everything.filter';
import { AutoMockingModule } from '../../test/auto-mocking/auto-mocking.module';
import { ConflictException, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
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

  it.each([
    new Prisma.PrismaClientUnknownRequestError(
      'query contains private customer data',
      { clientVersion: 'test' },
    ),
    new Prisma.PrismaClientValidationError(
      'query contains private customer data',
      { clientVersion: 'test' },
    ),
    new Prisma.PrismaClientKnownRequestError(
      'query contains private customer data',
      { clientVersion: 'test', code: 'P2024' },
    ),
    new Prisma.PrismaClientInitializationError(
      'query contains private customer data',
      'test',
    ),
  ])('does not log raw Prisma query arguments: %s', (error) => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    const logError = jest.spyOn(Logger.prototype, 'error').mockImplementation();
    try {
      const adapter = new HttpAdapterHost();
      adapter.httpAdapter = new ExpressAdapter();
      const reply = jest
        .spyOn(adapter.httpAdapter, 'reply')
        .mockImplementation();
      const actualFilter = new CatchEverythingFilter(
        adapter,
        new ZodExceptionService(),
      );
      actualFilter.catch(
        error,
        new ExecutionContextHost([
          {
            method: 'GET',
            path: '/test',
            headers: {},
            requestId: 'request-id',
            acceptsLanguages: () => 'en',
          },
          { locals: {}, setHeader: jest.fn() },
        ]),
      );
      expect(reply).toHaveBeenCalled();
      expect(
        JSON.stringify([...warn.mock.calls, ...logError.mock.calls]),
      ).not.toContain('private customer data');
      expect(
        JSON.stringify([...warn.mock.calls, ...logError.mock.calls]),
      ).toContain('/test');
    } finally {
      jest.restoreAllMocks();
    }
  });

  it.each([
    ['P2034', undefined, 409, 'TRANSACTION_CONFLICT'],
    ['P2010', '40001', 409, 'TRANSACTION_CONFLICT'],
    ['P2010', '40P01', 409, 'TRANSACTION_CONFLICT'],
    ['P2024', undefined, 503, 'DATABASE_BUSY'],
    ['P2028', undefined, 500, 'P2028'],
    ['P2010', '23514', 500, 'P2010'],
  ] as const)(
    'maps %s/%s without suggesting unsafe retries',
    async (prismaCode, sqlState, status, code) => {
      const log = jest.spyOn(Logger.prototype, 'error').mockImplementation();
      const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
      try {
        const adapter = new HttpAdapterHost();
        adapter.httpAdapter = new ExpressAdapter();
        const actualFilter = new CatchEverythingFilter(
          adapter,
          new ZodExceptionService(),
        );
        const app = express().use(httpLocaleMiddleware);
        let mutations = 0;
        app.post('/db-error', (req, res) => {
          mutations++;
          Object.assign(req, { requestId: 'database-request-id' });
          actualFilter.catch(
            new Prisma.PrismaClientKnownRequestError(
              'private-query-arguments',
              {
                code: prismaCode,
                clientVersion: 'test',
                meta: sqlState ? { code: sqlState } : undefined,
              },
            ),
            new ExecutionContextHost([req, res]),
          );
        });
        for (const locale of ['vi', 'en']) {
          const result = await request(app)
            .post('/db-error')
            .set('Accept-Language', locale)
            .expect(status);
          expect(result.body).toMatchObject({
            data: null,
            code,
            requestId: 'database-request-id',
          });
          expect(result.headers['retry-after']).toBe(
            code === 'DATABASE_BUSY' ? '1' : undefined,
          );
          expect(JSON.stringify(result.body)).not.toContain(
            'private-query-arguments',
          );
          if (code === 'TRANSACTION_CONFLICT')
            expect(result.body.errors[0].message).toContain(
              locale === 'vi' ? 'Tải lại' : 'Reload',
            );
          if (code === 'DATABASE_BUSY')
            expect(result.body.errors[0].message).toContain(
              locale === 'vi' ? 'đang bận' : 'busy',
            );
        }
        expect(mutations).toBe(2);
      } finally {
        log.mockRestore();
        warn.mockRestore();
      }
    },
  );

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
