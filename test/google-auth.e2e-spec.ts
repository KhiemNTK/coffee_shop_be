import { randomUUID } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import bcrypt from 'bcrypt';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from '../src/app/app.module';
import { GoogleIdentityService } from '../src/app/auth/google-identity.service';
import { TurnstileService } from '../src/app/auth/turnstile.service';
import { PrismaService } from '../src/common/prisma/prisma.service';
import { initApp } from '../src/init';

const cookiesFrom = (response: request.Response) => {
  const header = response.headers['set-cookie'] as
    | string[]
    | string
    | undefined;
  return (Array.isArray(header) ? header : [header])
    .filter((value): value is string => Boolean(value))
    .map((value) => value.split(';', 1)[0]);
};

const csrfFrom = (cookies: string[]) => {
  const cookie = cookies.find((value) => value.startsWith('csrfToken='));
  if (!cookie) throw new Error('Missing CSRF cookie');
  return decodeURIComponent(cookie.slice('csrfToken='.length));
};

describe('Google employee authentication (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let prefix: string;
  let employeeId: string | undefined;
  let positionId: string | undefined;
  let email: string;
  const password = 'CorrectHorseBatteryStaple1!';
  const idToken = 'g'.repeat(100);
  const wrongEmailToken = 'w'.repeat(100);
  const subject = `google-${randomUUID()}`;
  const verifyHuman = jest.fn(() => Promise.resolve());

  beforeAll(async () => {
    const moduleFixture = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(GoogleIdentityService)
      .useValue({
        verify: jest.fn((token: string) =>
          Promise.resolve({
            subject,
            email: token === wrongEmailToken ? 'different@example.com' : email,
          }),
        ),
      })
      .overrideProvider(TurnstileService)
      .useValue({ verify: verifyHuman })
      .compile();

    const expressApp =
      moduleFixture.createNestApplication<NestExpressApplication>();
    initApp(expressApp);
    app = expressApp;
    prisma = moduleFixture.get(PrismaService);
    prefix = moduleFixture.get(ConfigService).get('APP_PREFIX', '/api/v1');
    await app.init();

    const suffix = randomUUID();
    const position = await prisma.position.create({
      data: { name: `Google E2E ${suffix}`, salary: 0 },
    });
    positionId = position.id;
    email = `google-e2e-${suffix}@example.com`;
    const employee = await prisma.employee.create({
      data: {
        email,
        username: `google-e2e-${suffix}`,
        fullName: 'Google E2E Employee',
        password: await bcrypt.hash(password, 4),
        positionId: position.id,
        isActive: true,
      },
    });
    employeeId = employee.id;
  });

  afterAll(async () => {
    try {
      if (employeeId) {
        await prisma.$transaction(async (tx) => {
          await tx.$executeRawUnsafe(
            "SET LOCAL app.allow_audit_log_mutation = 'on'",
          );
          await tx.actionLog.deleteMany({ where: { employeeId } });
          await tx.authSession.deleteMany({ where: { employeeId } });
          await tx.employee.delete({ where: { id: employeeId } });
        });
      }
      if (positionId)
        await prisma.position.delete({ where: { id: positionId } });
    } finally {
      await app?.close();
    }
  });

  it('requires explicit linking and revokes sessions when unlinked', async () => {
    await request(app.getHttpServer())
      .post(`${prefix}/auth/google`)
      .send({ idToken })
      .expect(401);

    const passwordLogin = await request(app.getHttpServer())
      .post(`${prefix}/auth/sign-in`)
      .send({ email, password })
      .expect(201);
    const passwordCookies = cookiesFrom(passwordLogin);
    const link = (token: string, suppliedPassword: string) =>
      request(app.getHttpServer())
        .post(`${prefix}/auth/google/link`)
        .set('Cookie', passwordCookies.join('; '))
        .set('X-CSRF-Token', csrfFrom(passwordCookies))
        .send({ idToken: token, password: suppliedPassword });

    await link(idToken, 'incorrect').expect(401);
    await link(wrongEmailToken, password).expect(400);
    await link(idToken, password).expect(201);
    expect(
      (await prisma.employee.findUniqueOrThrow({ where: { id: employeeId } }))
        .googleSubject,
    ).toBe(subject);

    const profile = await request(app.getHttpServer())
      .get(`${prefix}/auth/me`)
      .set('Cookie', passwordCookies.join('; '))
      .expect(200);
    expect(profile.body.data.googleLinked).toBe(true);
    expect(profile.body.data.googleSubject).toBeUndefined();

    const googleLogin = await request(app.getHttpServer())
      .post(`${prefix}/auth/google`)
      .send({ idToken })
      .expect(201);
    const googleCookies = cookiesFrom(googleLogin);
    await request(app.getHttpServer())
      .get(`${prefix}/auth/me`)
      .set('Cookie', googleCookies.join('; '))
      .expect(200);

    await prisma.employee.update({
      where: { id: employeeId },
      data: { isActive: false },
    });
    await request(app.getHttpServer())
      .post(`${prefix}/auth/google`)
      .send({ idToken })
      .expect(401);
    await request(app.getHttpServer())
      .get(`${prefix}/auth/me`)
      .set('Cookie', googleCookies.join('; '))
      .expect(401);
    await prisma.employee.update({
      where: { id: employeeId },
      data: { isActive: true },
    });

    await request(app.getHttpServer())
      .post(`${prefix}/auth/google/unlink`)
      .set('Cookie', passwordCookies.join('; '))
      .set('X-CSRF-Token', csrfFrom(passwordCookies))
      .send({ password })
      .expect(201);
    expect(
      (await prisma.employee.findUniqueOrThrow({ where: { id: employeeId } }))
        .googleSubject,
    ).toBeNull();
    await request(app.getHttpServer())
      .get(`${prefix}/auth/me`)
      .set('Cookie', googleCookies.join('; '))
      .expect(401);
    await request(app.getHttpServer())
      .post(`${prefix}/auth/google`)
      .send({ idToken })
      .expect(401);
    await request(app.getHttpServer())
      .post(`${prefix}/auth/sign-in`)
      .send({ email, password })
      .expect(201);
  });

  it('uses the password-reset Turnstile action for reset requests', async () => {
    await request(app.getHttpServer())
      .post(`${prefix}/auth/forgot-password`)
      .send({ email: 'nonexistent@example.com', turnstileToken: 'challenge' })
      .expect(201);
    expect(verifyHuman).toHaveBeenCalledWith(
      'challenge',
      expect.any(String),
      'password_reset',
    );
  });
});
