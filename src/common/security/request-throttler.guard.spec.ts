import {
  Controller,
  Get,
  Injectable,
  UnauthorizedException,
  type ExecutionContext,
  type INestApplication,
} from '@nestjs/common';
import { APP_GUARD, Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { SkipThrottle, Throttle, ThrottlerModule } from '@nestjs/throttler';
import request from 'supertest';
import type { App } from 'supertest/types';
import { IS_SKIP_AUTH, SkipAuth } from '../../app/auth/auth.decorator';
import {
  EmployeeThrottlerGuard,
  IngressThrottlerGuard,
} from './request-throttler.guard';
import type { AuthenticatedStaffRequest } from '../types';

@Injectable()
class VerifiedEmployeeFixtureGuard {
  static calls = 0;
  constructor(private readonly reflector: Reflector) {}
  canActivate(context: ExecutionContext) {
    if (
      this.reflector.getAllAndOverride(IS_SKIP_AUTH, [
        context.getHandler(),
        context.getClass(),
      ])
    )
      return true;
    VerifiedEmployeeFixtureGuard.calls++;
    const req = context.switchToHttp().getRequest<AuthenticatedStaffRequest>();
    const authorization = req.headers.authorization ?? '';
    if (
      !['Bearer employee-a', 'Bearer employee-b', 'Bearer employee-c'].includes(
        authorization,
      )
    )
      throw new UnauthorizedException();
    req.employee = { employeeId: authorization.slice(7) };
    return true;
  }
}

@Controller('rate-probe')
class RateProbeController {
  @Get('staff') staff() {
    return { ok: true };
  }
  @Get('public')
  @SkipAuth()
  @Throttle({ default: { limit: 1, ttl: 60_000 } })
  public() {
    return { ok: true };
  }
  @Get('metrics') @SkipAuth() @SkipThrottle() metrics() {
    return { ok: true };
  }
}

describe('Two-stage request throttling', () => {
  let app: INestApplication;
  beforeEach(async () => {
    VerifiedEmployeeFixtureGuard.calls = 0;
    const module = await Test.createTestingModule({
      imports: [ThrottlerModule.forRoot([{ ttl: 60_000, limit: 2 }])],
      controllers: [RateProbeController],
      providers: [
        { provide: APP_GUARD, useClass: IngressThrottlerGuard },
        { provide: APP_GUARD, useClass: VerifiedEmployeeFixtureGuard },
        { provide: APP_GUARD, useClass: EmployeeThrottlerGuard },
      ],
    }).compile();
    app = module.createNestApplication();
    await app.init();
  });
  afterEach(async () => {
    await app?.close();
  });

  it('separates verified employees behind the same IP without trusting an employee header', async () => {
    for (const employee of ['a', 'b', 'c'])
      await request(app.getHttpServer() as App)
        .get('/rate-probe/staff')
        .set('Authorization', `Bearer employee-${employee}`)
        .expect(200);
    await request(app.getHttpServer() as App)
      .get('/rate-probe/staff')
      .set('Authorization', 'Bearer employee-a')
      .expect(200);
    await request(app.getHttpServer() as App)
      .get('/rate-probe/staff')
      .set('Authorization', 'Bearer employee-a')
      .set('X-Employee-Id', 'employee-b')
      .expect(429)
      .expect('Retry-After', /\d+/);
    await request(app.getHttpServer() as App)
      .get('/rate-probe/staff')
      .set('Authorization', 'Bearer employee-b')
      .expect(200);
  });

  it('keeps the strict public policy and allows explicitly exempt monitoring routes', async () => {
    await request(app.getHttpServer() as App)
      .get('/rate-probe/public')
      .expect(200);
    await request(app.getHttpServer() as App)
      .get('/rate-probe/public')
      .expect(429);
    for (let index = 0; index < 3; index++)
      await request(app.getHttpServer() as App)
        .get('/rate-probe/metrics')
        .expect(200);
  });

  it('blocks an unauthenticated IP before authentication once the coarse budget is spent', async () => {
    for (let index = 0; index < 20; index++)
      await request(app.getHttpServer() as App)
        .get('/rate-probe/staff')
        .expect(401);
    await request(app.getHttpServer() as App)
      .get('/rate-probe/staff')
      .expect(429);
    expect(VerifiedEmployeeFixtureGuard.calls).toBe(20);
  });
});
