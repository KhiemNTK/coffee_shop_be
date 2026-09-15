import { randomUUID } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { NestExpressApplication } from '@nestjs/platform-express';
import bcrypt from 'bcrypt';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from '../src/app/app.module';
import { PrismaService } from '../src/common/prisma/prisma.service';
import { initApp } from '../src/init';

const extractCookies = (response: request.Response) => {
  const rawCookies = response.headers['set-cookie'] as
    | string
    | string[]
    | undefined;
  const cookies = Array.isArray(rawCookies) ? rawCookies : [rawCookies];
  return cookies
    .filter((cookie): cookie is string => Boolean(cookie))
    .map((cookie) => cookie.split(';', 1)[0]);
};

const getCookieValue = (cookies: string[], name: string) => {
  const cookie = cookies.find((entry) => entry.startsWith(`${name}=`));
  if (!cookie) throw new Error(`Missing ${name} cookie`);
  return decodeURIComponent(cookie.slice(name.length + 1));
};

describe('Application security baseline (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let apiPrefix: string;
  let employeeId: string | undefined;
  let positionId: string | undefined;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    const expressApp =
      moduleFixture.createNestApplication<NestExpressApplication>();
    initApp(expressApp);
    app = expressApp;
    prisma = moduleFixture.get(PrismaService);
    apiPrefix = moduleFixture
      .get(ConfigService)
      .get<string>('APP_PREFIX', '/api/v1');
    await app.init();
  });

  afterAll(async () => {
    try {
      if (employeeId) {
        await prisma.employee.deleteMany({ where: { id: employeeId } });
      }
      if (positionId) {
        await prisma.position.deleteMany({ where: { id: positionId } });
      }
    } finally {
      await app?.close();
    }
  });

  it('serves the public smoke endpoint through the configured API prefix', () =>
    request(app.getHttpServer())
      .get(`${apiPrefix}/`)
      .expect(200)
      .expect(({ body }) => {
        expect(body.data).toBe('Hello World!');
      }));

  it('rotates refresh tokens, detects replay, and enforces default-deny', async () => {
    const unique = randomUUID();
    const password = 'CorrectHorseBatteryStaple1!';
    const position = await prisma.position.create({
      data: { name: `E2E-${unique}`, salary: 0 },
    });
    positionId = position.id;
    const employee = await prisma.employee.create({
      data: {
        email: `e2e-${unique}@example.com`,
        username: `e2e-${unique}`,
        fullName: 'E2E Employee',
        password: await bcrypt.hash(password, 4),
        positionId: position.id,
        isActive: true,
      },
    });
    employeeId = employee.id;

    const signIn = await request(app.getHttpServer())
      .post(`${apiPrefix}/auth/sign-in`)
      .send({ email: employee.email, password })
      .expect(201);
    const originalCookies = extractCookies(signIn);
    const originalCsrfToken = getCookieValue(originalCookies, 'csrfToken');

    await request(app.getHttpServer())
      .get(`${apiPrefix}/auth/me`)
      .set('Cookie', originalCookies.join('; '))
      .expect(200);

    await request(app.getHttpServer())
      .get(`${apiPrefix}/employees`)
      .set('Cookie', originalCookies.join('; '))
      .expect(403);

    const refresh = await request(app.getHttpServer())
      .post(`${apiPrefix}/auth/refresh`)
      .set('Cookie', originalCookies.join('; '))
      .set('X-CSRF-Token', originalCsrfToken)
      .expect(201);
    const rotatedCookies = extractCookies(refresh);

    await request(app.getHttpServer())
      .post(`${apiPrefix}/auth/refresh`)
      .set('Cookie', originalCookies.join('; '))
      .set('X-CSRF-Token', originalCsrfToken)
      .expect(401);

    await request(app.getHttpServer())
      .get(`${apiPrefix}/auth/me`)
      .set('Cookie', rotatedCookies.join('; '))
      .expect(401);
  });
});
