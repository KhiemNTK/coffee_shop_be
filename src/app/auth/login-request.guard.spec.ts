import { Test } from '@nestjs/testing';
import { APP_GUARD } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { ZodValidationPipe } from 'nestjs-zod';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import request from 'supertest';
import type { App } from 'supertest/types';
import cookieParser from 'cookie-parser';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { AuthGuard } from './auth.guard';
import { CsrfGuard } from './csrf.guard';
import { LoginRequestGuard } from './login-request.guard';
import { CustomersController } from '../customers/customers.controller';
import { CustomersService } from '../customers/customers.service';
import { CustomerGuard } from '../customers/customer.guard';
import type { INestApplication } from '@nestjs/common';

describe('Login request and session-cookie boundary (HTTP)', () => {
  const origin = 'https://coffee.example.test';
  const id = '7a67e1c8-bc65-40d9-ad05-0ecc8fbbec90';
  const tokens = {
    accessToken: 'fixture-access',
    refreshToken: 'fixture-refresh',
  };
  const auth = {
    signUp: jest.fn().mockResolvedValue(tokens),
    signIn: jest.fn().mockResolvedValue(tokens),
    signInWithGoogle: jest.fn().mockResolvedValue(tokens),
    verifyAccessToken: jest.fn().mockResolvedValue({ sub: id, sid: id }),
    getAuthenticatedEmployee: jest.fn().mockResolvedValue({ employeeId: id }),
    getMe: jest.fn().mockResolvedValue({ id, email: 'fixture@example.test' }),
    resetPassword: jest.fn().mockResolvedValue({ message: 'Reset fixture' }),
    refreshToken: jest.fn().mockResolvedValue(tokens),
  };
  const customers = {
    signIn: jest.fn().mockResolvedValue({
      token: 'fixture-customer',
      customer: { id, email: 'fixture@example.test' },
    }),
  };
  const routes = [
    [
      '/auth/sign-in',
      { email: 'fixture@example.test', password: 'fixture-password' },
      201,
    ],
    [
      '/auth/sign-up',
      {
        email: 'fixture@example.test',
        password: 'fixture-password',
        fullName: 'Fixture staff',
        username: 'fixture',
      },
      201,
    ],
    ['/auth/google', { idToken: 'x'.repeat(100) }, 201],
    ['/customers/auth/google', { idToken: 'x'.repeat(100) }, 200],
  ] as const;
  let app: INestApplication<App>;

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      imports: [ThrottlerModule.forRoot([{ ttl: 60_000, limit: 1000 }])],
      controllers: [AuthController, CustomersController],
      providers: [
        {
          provide: ConfigService,
          useValue: new ConfigService({ FE_URL: origin, CSRF_ENABLED: true }),
        },
        { provide: AuthService, useValue: auth },
        { provide: CustomersService, useValue: customers },
        LoginRequestGuard,
        CustomerGuard,
        { provide: APP_GUARD, useClass: ThrottlerGuard },
        { provide: APP_GUARD, useClass: AuthGuard },
        { provide: APP_GUARD, useClass: CsrfGuard },
      ],
    }).compile();
    app = module.createNestApplication({ logger: false });
    app.use(cookieParser());
    app.enableCors({ origin: [origin], credentials: true });
    app.useGlobalPipes(new ZodValidationPipe());
    await app.init();
  });
  afterAll(async () => app?.close());
  beforeEach(() => jest.clearAllMocks());

  it.each(routes)(
    'allows JSON login from a trusted origin: %s',
    async (path, body, status) => {
      await request(app.getHttpServer())
        .post(path)
        .set('Origin', origin)
        .send(body)
        .expect(status);
    },
  );
  it.each(routes)(
    'supports header-less JSON API clients: %s',
    async (path, body, status) => {
      await request(app.getHttpServer()).post(path).send(body).expect(status);
    },
  );
  it.each(routes)(
    'rejects form login before authentication work: %s',
    async (path, body) => {
      await request(app.getHttpServer())
        .post(path)
        .set('Origin', origin)
        .type('form')
        .send(body)
        .expect(415);
      expect(auth.signIn).not.toHaveBeenCalled();
      expect(auth.signUp).not.toHaveBeenCalled();
      expect(auth.signInWithGoogle).not.toHaveBeenCalled();
      expect(customers.signIn).not.toHaveBeenCalled();
    },
  );
  it.each(routes)(
    'rejects an untrusted Origin even for JSON login: %s',
    async (path, body) => {
      await request(app.getHttpServer())
        .post(path)
        .set('Origin', 'https://untrusted.example.test')
        .send(body)
        .expect(403);
      expect(auth.signIn).not.toHaveBeenCalled();
      expect(customers.signIn).not.toHaveBeenCalled();
    },
  );
  it.each([
    { Origin: 'null' },
    { Origin: origin + '.untrusted.test' },
    { Referer: 'https://untrusted.example.test/' + origin },
    { Referer: 'not-a-url' },
    { 'Sec-Fetch-Site': 'cross-site' },
  ])(
    'rejects opaque, misleading, or cross-site browser source headers: %j',
    async (headers) => {
      await request(app.getHttpServer())
        .post('/auth/sign-in')
        .set(headers)
        .send(routes[0][1])
        .expect(403);
    },
  );
  it('accepts a trusted Referer fallback with an explicit JSON content type', async () => {
    await request(app.getHttpServer())
      .post('/auth/sign-in')
      .set('Referer', origin + '/sign-in')
      .send(routes[0][1])
      .expect(201);
  });
  it('keeps CSRF cookies persistent and restores them only for authenticated cookie sessions', async () => {
    const login = await request(app.getHttpServer())
      .post('/auth/sign-in')
      .send(routes[0][1])
      .expect(201);
    const csrf = (login.headers['set-cookie'] as unknown as string[]).find(
      (value) => value.startsWith('csrfToken='),
    );
    expect(csrf).toContain('Max-Age=2592000');
    const restored = await request(app.getHttpServer())
      .get('/auth/me')
      .set('Cookie', 'accessToken=fixture-access')
      .expect(200)
      .expect('Cache-Control', 'no-store');
    const restoredCookie = (
      restored.headers['set-cookie'] as unknown as string[]
    )[0];
    expect(restoredCookie).toMatch(/^csrfToken=[A-Za-z0-9_-]{43};/);
    expect(restoredCookie).toContain('Max-Age=2592000');
    const unchanged = await request(app.getHttpServer())
      .get('/auth/me')
      .set('Cookie', [
        'accessToken=fixture-access',
        'csrfToken=' + 'a'.repeat(43),
      ])
      .expect(200);
    expect(unchanged.headers['set-cookie']).toBeUndefined();
    const bearer = await request(app.getHttpServer())
      .get('/auth/me')
      .set('Authorization', 'Bearer fixture-access')
      .expect(200);
    expect(bearer.headers['set-cookie']).toBeUndefined();
  });
  it('keeps CSRF mandatory for refresh and gives reset its own rate limit', async () => {
    await request(app.getHttpServer())
      .post('/auth/refresh')
      .set('Cookie', 'refreshToken=fixture-refresh')
      .send({})
      .expect(403);
    expect(auth.refreshToken).not.toHaveBeenCalled();
    for (let i = 0; i < 5; i++)
      await request(app.getHttpServer())
        .post('/auth/reset-password')
        .send({ token: 'x'.repeat(43), password: 'fixture-new-password' })
        .expect(201);
    await request(app.getHttpServer())
      .post('/auth/reset-password')
      .send({ token: 'x'.repeat(43), password: 'fixture-new-password' })
      .expect(429)
      .expect('Retry-After', /\d+/);
    expect(auth.resetPassword).toHaveBeenCalledTimes(5);
  });
});
