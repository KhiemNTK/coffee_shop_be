import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Logger, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import type { Employee } from '@prisma/client';
import bcrypt from 'bcrypt';
import { AuthSessionService } from '../src/app/auth/auth-session.service';
import { AuthTokenService } from '../src/app/auth/auth-token.service';
import { AuthService } from '../src/app/auth/auth.service';
import { PasswordResetService } from '../src/app/auth/password-reset.service';
import { TurnstileService } from '../src/app/auth/turnstile.service';
import { EmployeesService } from '../src/app/employees/employees.service';
import { AUTH_ERRORS } from '../src/common/consts/message';
import { PrismaService } from '../src/common/prisma/prisma.service';
import { PaginationUtilService } from '../src/common/utils/pagination-util/pagination-util.service';
import { PasswordHashService } from '../src/common/utils/password-hash/password-hash.service';
import type { AuthTokenPair } from '../src/common/types';

// Run with --maxWorkers=1 against a dedicated loopback *_test database.
describe('Password sign-in races (PostgreSQL)', () => {
  const originalUrl = process.env.DATABASE_URL;
  const password = 'CorrectHorseBatteryStaple1!';
  let base: PrismaService;
  let positionId: string;
  let employee: Employee;
  let auth: AuthService;
  let sessions: AuthSessionService;
  let tokens: AuthTokenService;
  let passwordHash: PasswordHashService;

  beforeAll(async () => {
    assert(originalUrl, 'DATABASE_URL must be explicitly set.');
    const target = new URL(originalUrl);
    assert(
      process.env.NODE_ENV === 'test' &&
        ['postgres:', 'postgresql:'].includes(target.protocol) &&
        ['127.0.0.1', 'localhost'].includes(target.hostname) &&
        /^[^/]+_test$/.test(decodeURIComponent(target.pathname.slice(1))),
      'Only use a dedicated loopback PostgreSQL test database.',
    );
    base = new PrismaService();
    await base.$connect();
    const prisma = base.getExtendedClient();
    const config = new ConfigService({
      NODE_ENV: 'test',
      FE_URL: 'http://localhost:3001',
      JWT_SECRET: 'test-only-password-race-access-secret',
      JWT_REFRESH_SECRET: 'test-only-password-race-refresh-secret',
      TURNSTILE_SECRET_KEY: '',
    });
    passwordHash = new PasswordHashService();
    tokens = new AuthTokenService(new JwtService(), config);
    sessions = new AuthSessionService(prisma, tokens);
    const reset = new PasswordResetService(
      prisma,
      config,
      passwordHash,
      {} as never,
      tokens,
      {} as never,
      {} as never,
    );
    const employees = new EmployeesService(
      prisma,
      new PaginationUtilService(),
      {} as never,
      passwordHash,
    );
    auth = new AuthService(
      prisma,
      employees,
      passwordHash,
      config,
      {} as never,
      tokens,
      sessions,
      reset,
      {} as never,
      new TurnstileService(config),
    );
    const position = await base.position.create({
      data: { name: `Password race ${randomUUID()}`, salary: 0 },
    });
    positionId = position.id;
  }, 30_000);

  beforeEach(async () => {
    const suffix = randomUUID();
    employee = await base.employee.create({
      data: {
        email: `password-race-${suffix}@example.com`,
        username: suffix,
        fullName: 'Password race test',
        password: await bcrypt.hash(password, 4),
        positionId,
        isActive: true,
      },
    });
  });

  afterAll(async () => {
    try {
      if (base && positionId) {
        await base.authSession.deleteMany({
          where: { employee: { positionId } },
        });
        await base.passwordResetToken.deleteMany({
          where: { employee: { positionId } },
        });
        await base.employee.deleteMany({ where: { positionId } });
        await base.position.delete({ where: { id: positionId } });
      }
    } finally {
      await base?.$disconnect();
    }
  });

  it('rejects an old-password sign-in when a concurrent reset commits after verification', async () => {
    await auth.signIn({ email: employee.email, password }, {});
    const resetToken = randomUUID();
    await base.passwordResetToken.create({
      data: {
        employeeId: employee.id,
        tokenHash: tokens.hashToken(resetToken),
        expiresAt: new Date(Date.now() + 60_000),
      },
    });
    const verified = Promise.withResolvers<boolean>();
    const resume = Promise.withResolvers<void>();
    const compare: PasswordHashService['compare'] =
      passwordHash.compare.bind(passwordHash);
    const compareSpy = jest
      .spyOn(passwordHash, 'compare')
      .mockImplementationOnce(async (value, hash) => {
        const matches = await compare(value, hash);
        verified.resolve(matches);
        await resume.promise;
        return matches;
      });
    const signIn = Promise.allSettled([
      auth.signIn({ email: employee.email, password }, {}),
    ]);

    try {
      expect(
        await Promise.race([
          verified.promise,
          signIn.then(() => {
            throw new Error('Sign-in ended before password verification.');
          }),
        ]),
      ).toBe(true);
      await expect(
        auth.resetPassword({
          token: resetToken,
          password: 'NewCorrectHorseBatteryStaple2!',
        }),
      ).resolves.toEqual({ message: 'Password reset successfully.' });
    } finally {
      resume.resolve();
      await signIn;
      compareSpy.mockRestore();
    }

    const [result] = await signIn;
    expect(result.status).toBe('rejected');
    assert(result.status === 'rejected');
    expect(result.reason).toBeInstanceOf(UnauthorizedException);
    expect(result.reason.message).toBe(AUTH_ERRORS.INVALID_CREDENTIALS);
    const stored = await base.authSession.findMany({
      where: { employeeId: employee.id },
    });
    expect(stored).toHaveLength(1);
    expect(stored[0].revokedAt).not.toBeNull();
    expect(stored[0].revokeReason).toBe('PASSWORD_RESET');
    await expect(
      auth.signIn({ email: employee.email, password }, {}),
    ).rejects.toThrow(AUTH_ERRORS.INVALID_CREDENTIALS);
    await expect(
      auth.signIn(
        {
          email: employee.email,
          password: 'NewCorrectHorseBatteryStaple2!',
        },
        {},
      ),
    ).resolves.toEqual({
      accessToken: expect.any(String),
      refreshToken: expect.any(String),
    });
  }, 10_000);

  it.each([{ isActive: false }, { deletedAt: new Date() }])(
    'rejects session creation when the verified employee state changes to %p',
    async (data) => {
      await base.employee.update({ where: { id: employee.id }, data });

      await expect(
        sessions.createSession(employee, {}, undefined, employee.password),
      ).rejects.toThrow(AUTH_ERRORS.INVALID_CREDENTIALS);
      expect(
        await base.authSession.count({ where: { employeeId: employee.id } }),
      ).toBe(0);
    },
  );

  it('revokes a successor committed after the logout snapshot without revoking another device', async () => {
    const old = await sessions.createSession(
      employee,
      {},
      undefined,
      employee.password,
    );
    const other = await sessions.createSession(
      employee,
      {},
      undefined,
      employee.password,
    );
    const read = Promise.withResolvers<void>();
    const resume = Promise.withResolvers<void>();
    let paused = false;
    const client = base.getExtendedClient().$extends({
      query: {
        authSession: {
          async updateMany({ args, query }) {
            if (args.data.revokeReason === 'LOGOUT' && !paused) {
              paused = true;
              read.resolve();
              await resume.promise;
            }
            return query(args);
          },
        },
      },
    });
    const logoutSessions = new AuthSessionService(client, tokens);
    const logout = Promise.allSettled([
      logoutSessions.revoke(old.refreshToken),
    ]);
    let successor: AuthTokenPair | undefined;
    try {
      await Promise.race([
        read.promise,
        logout.then(() => {
          throw new Error('Logout ended before the race checkpoint.');
        }),
      ]);
      successor = await sessions.rotate(old.refreshToken, {});
    } finally {
      resume.resolve();
      await logout;
    }
    expect((await logout)[0].status).toBe('fulfilled');
    const original = await tokens.verifyRefreshToken(old.refreshToken);
    expect(
      await base.authSession.count({
        where: {
          employeeId: employee.id,
          familyId: original.familyId,
          revokedAt: null,
        },
      }),
    ).toBe(0);
    assert(successor);
    const next = await tokens.verifyAccessToken(successor.accessToken);
    await expect(
      auth.getAuthenticatedEmployee(employee.id, next.sid),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    const otherDevice = await tokens.verifyAccessToken(other.accessToken);
    await expect(
      auth.getAuthenticatedEmployee(employee.id, otherDevice.sid),
    ).resolves.toMatchObject({ employeeId: employee.id });
  }, 15_000);

  it('consumes a reset token only once when two new passwords are submitted concurrently', async () => {
    const token = randomUUID();
    await base.passwordResetToken.create({
      data: {
        employeeId: employee.id,
        tokenHash: tokens.hashToken(token),
        expiresAt: new Date(Date.now() + 60_000),
      },
    });
    await sessions.createSession(employee, {}, undefined, employee.password);
    const passwords = ['FirstNewPassword123!', 'SecondNewPassword123!'];
    const results = await Promise.allSettled(
      passwords.map((password) => auth.resetPassword({ token, password })),
    );
    expect(
      results.filter((result) => result.status === 'fulfilled'),
    ).toHaveLength(1);
    const rejected = results.find((result) => result.status === 'rejected');
    assert(rejected?.status === 'rejected');
    expect(rejected.reason).toBeInstanceOf(UnauthorizedException);
    const winner = results.findIndex((result) => result.status === 'fulfilled');
    const saved = await base.employee.findUniqueOrThrow({
      where: { id: employee.id },
    });
    expect(await bcrypt.compare(passwords[winner], saved.password)).toBe(true);
    expect(
      await base.authSession.count({
        where: { employeeId: employee.id, revokedAt: null },
      }),
    ).toBe(0);
  }, 15_000);

  it('revokes a concurrently rotated descendant on replay without affecting another device', async () => {
    const parent = await sessions.createSession(
      employee,
      {},
      undefined,
      employee.password,
    );
    const child = await sessions.rotate(parent.refreshToken, {});
    const other = await sessions.createSession(
      employee,
      {},
      undefined,
      employee.password,
    );
    const reached = Promise.withResolvers<void>();
    const resume = Promise.withResolvers<void>();
    let paused = false;
    const client = base.getExtendedClient().$extends({
      query: {
        authSession: {
          async create({ args, query }) {
            if (!paused) {
              paused = true;
              reached.resolve();
              await resume.promise;
            }
            return query(args);
          },
        },
      },
    });
    const warning = jest.spyOn(Logger, 'warn').mockImplementation();
    const descendant = Promise.allSettled([
      new AuthSessionService(client, tokens).rotate(child.refreshToken, {}),
    ]);
    let replay: Promise<PromiseSettledResult<AuthTokenPair>[]> | undefined;
    try {
      await Promise.race([
        reached.promise,
        descendant.then(() => {
          throw new Error('Rotation did not reach the insert barrier.');
        }),
      ]);
      replay = Promise.allSettled([sessions.rotate(parent.refreshToken, {})]);
      let blocked = false;
      const until = Date.now() + 3000;
      while (!blocked && Date.now() < until) {
        const [state] = await base.$queryRaw<Array<{ blocked: boolean }>>`
          SELECT EXISTS (
            SELECT 1 FROM pg_stat_activity
            WHERE datname = current_database() AND wait_event_type = 'Lock'
          ) AS blocked
        `;
        blocked = state.blocked;
        if (!blocked) await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(blocked).toBe(true);
    } finally {
      resume.resolve();
      await descendant;
      await replay;
      warning.mockRestore();
    }
    const outcome = (await replay)[0];
    assert(outcome.status === 'rejected');
    expect(outcome.reason).toBeInstanceOf(UnauthorizedException);
    const payload = await tokens.verifyRefreshToken(parent.refreshToken);
    expect(
      await base.authSession.count({
        where: {
          employeeId: employee.id,
          familyId: payload.familyId,
          revokedAt: null,
        },
      }),
    ).toBe(0);
    const otherPayload = await tokens.verifyAccessToken(other.accessToken);
    await expect(
      auth.getAuthenticatedEmployee(employee.id, otherPayload.sid),
    ).resolves.toMatchObject({ employeeId: employee.id });
  }, 15_000);

  it('rejects a refresh whose session was revoked after its snapshot', async () => {
    const old = await sessions.createSession(
      employee,
      {},
      undefined,
      employee.password,
    );
    const read = Promise.withResolvers<void>();
    const resume = Promise.withResolvers<void>();
    let paused = false;
    const client = base.getExtendedClient().$extends({
      query: {
        authSession: {
          async findUnique({ args, query }) {
            const result = await query(args);
            if (!paused) {
              paused = true;
              read.resolve();
              await resume.promise;
            }
            return result;
          },
        },
      },
    });
    const refresh = Promise.allSettled([
      new AuthSessionService(client, tokens).rotate(old.refreshToken, {}),
    ]);
    try {
      await Promise.race([
        read.promise,
        refresh.then(() => {
          throw new Error('Refresh ended before the race checkpoint.');
        }),
      ]);
      await sessions.revoke(old.refreshToken);
    } finally {
      resume.resolve();
      await refresh;
    }
    const [outcome] = await refresh;
    assert(outcome.status === 'rejected');
    expect(outcome.reason).toBeInstanceOf(UnauthorizedException);
    expect(
      await base.authSession.count({
        where: { employeeId: employee.id, revokedAt: null },
      }),
    ).toBe(0);
  }, 15_000);
});
