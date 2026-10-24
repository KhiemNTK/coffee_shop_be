import express from 'express';
import request from 'supertest';
import { httpLocaleMiddleware } from './http-locale';
import { localizeApiErrors } from './error-messages';
import { ZodValidationException } from 'nestjs-zod';
import { z } from 'zod';

describe('HTTP language boundary', () => {
  const app = express().use(httpLocaleMiddleware);
  app.get('/', (_req, res) =>
    res.json({ code: 'STABLE_CODE', data: 'Coffee Homes' }),
  );

  it.each([
    [undefined, 'en'],
    ['vi-VN', 'vi'],
    ['en-US;q=0.5, vi-VN;q=0.9', 'vi'],
    ['vi;q=0, en;q=1', 'en'],
    ['ja-JP', 'en'],
    ['*', 'en'],
  ])(
    'negotiates %s as %s without changing business data',
    async (header, expected) => {
      const call = request(app).get('/');
      if (header) call.set('Accept-Language', header);
      const result = await call.expect(200);
      expect(result.headers['content-language']).toBe(expected);
      expect(result.headers.vary).toContain('Accept-Language');
      expect(result.body).toEqual({
        code: 'STABLE_CODE',
        data: 'Coffee Homes',
      });
    },
  );

  it('localizes coded errors without changing field paths or input objects', () => {
    const errors = [{ message: 'original', fields: ['unitId'] }];
    expect(localizeApiErrors(errors, 'vi', 'INVENTORY_UNIT_IMMUTABLE')).toEqual(
      [
        {
          message: 'Không thể đổi đơn vị tính của nguyên liệu đã tạo.',
          fields: ['unitId'],
        },
      ],
    );
    expect(errors[0]?.message).toBe('original');
    expect(localizeApiErrors(errors, 'en', 'INVENTORY_UNIT_IMMUTABLE')).toBe(
      errors,
    );
  });

  it('preserves unknown business reasons rather than replacing them with a generic error', () => {
    const errors = [{ message: 'A specific unregistered business reason' }];
    expect(localizeApiErrors(errors, 'vi', 'HTTP_409')).toEqual(errors);
  });

  it.each([
    'CASHIER_SHIFT_REQUIRED',
    'CASHIER_SHIFT_FUND_INVALID',
    'ONLINE_INTAKE_PAUSED',
    'ONLINE_INTAKE_CHANGED',
    'TURNSTILE_REQUIRED',
    'TURNSTILE_INVALID',
    'TURNSTILE_EXPIRED',
    'TURNSTILE_UNAVAILABLE',
    'ONLINE_ORDER_RECOVERY_NOT_FOUND',
  ])(
    'localizes the recovery message for %s without changing English',
    (code) => {
      const errors = [{ message: 'Original reason' }];
      expect(localizeApiErrors(errors, 'vi', code)[0].message).not.toBe(
        errors[0].message,
      );
      expect(localizeApiErrors(errors, 'en', code)).toBe(errors);
    },
  );

  it('localizes rate-limit outages without changing the stable code contract', () => {
    const errors = [
      { message: 'Rate limiting is temporarily unavailable. Please retry.' },
    ];
    expect(localizeApiErrors(errors, 'vi', 'RATE_LIMIT_UNAVAILABLE')).toEqual([
      { message: 'Dịch vụ tạm thời không khả dụng. Vui lòng thử lại sau.' },
    ]);
    expect(localizeApiErrors(errors, 'en', 'RATE_LIMIT_UNAVAILABLE')).toBe(
      errors,
    );
  });

  it('localizes Zod constraints without exposing the submitted value', () => {
    const result = z
      .object({ password: z.string().min(8) })
      .safeParse({ password: 'secret' });
    if (result.success) throw new Error('Fixture must fail validation');
    const exception = new ZodValidationException(result.error);
    const errors = [
      { message: result.error.issues[0].message, fields: ['password'] },
    ];
    const translated = localizeApiErrors(
      errors,
      'vi',
      'VALIDATION_ERROR',
      exception,
    );
    expect(translated[0]?.message).toContain('8');
    expect(translated[0]?.message).not.toContain('secret');
    expect(translated[0]?.fields).toEqual(['password']);
  });

  it('keeps exclusive numeric bounds exclusive when translated', () => {
    const result = z.number().gt(0).safeParse(0);
    if (result.success) throw new Error('Fixture must fail validation');
    const translated = localizeApiErrors(
      [{ message: result.error.issues[0].message }],
      'vi',
      'VALIDATION_ERROR',
      new ZodValidationException(result.error),
    );
    expect(translated[0]?.message).toContain('lớn hơn 0');
  });
});
