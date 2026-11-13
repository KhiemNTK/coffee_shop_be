import { TestingModule } from '@nestjs/testing';
import { AUTH_ERRORS } from '../../common/consts/message';
import { PasswordHashService } from '../../common/utils/password-hash/password-hash.service';
import { EmployeesService } from '../employees/employees.service';
import { AuthSessionService } from './auth-session.service';
import { AuthService } from './auth.service';
import { AutoMockingModule } from '../../../test/auto-mocking/auto-mocking.module';
import { AuthModule } from './auth.module';
import { Prisma } from '@prisma/client';
import type { ExtendedPrismaClient } from '../../common/prisma/prisma.service';
import { GoogleIdentityService } from './google-identity.service';

describe('AuthService', () => {
  let service: AuthService;
  let employees: EmployeesService;
  let passwordHash: PasswordHashService;
  let sessions: AuthSessionService;
  let prisma: ExtendedPrismaClient;
  let google: GoogleIdentityService;

  beforeEach(async () => {
    const module: TestingModule = await AutoMockingModule.createTestingModule({
      imports: [AuthModule],
    });

    service = module.get<AuthService>(AuthService);
    employees = module.get(EmployeesService);
    passwordHash = module
      .select(AuthModule)
      .get(PasswordHashService, { strict: true });
    sessions = module.get(AuthSessionService);
    prisma = service['prisma'];
    google = service['googleIdentity'];
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  it('passes the password hash that was verified to session creation', async () => {
    const employee = {
      id: 'employee-1',
      email: 'owner@example.com',
      password: 'verified-password-hash',
      isActive: true,
    };
    jest.spyOn(employees, 'getEmployee').mockResolvedValue(employee as never);
    const compare = jest.spyOn(passwordHash, 'compare').mockResolvedValue(true);
    const tokens = { accessToken: 'access', refreshToken: 'refresh' };
    const createSession = jest
      .spyOn(sessions, 'createSession')
      .mockResolvedValue(tokens);
    const metadata = { ipAddress: '127.0.0.1' };

    await expect(
      service.signIn({ email: employee.email, password: 'password' }, metadata),
    ).resolves.toEqual(tokens);
    expect(compare).toHaveBeenCalledWith('password', employee.password);
    expect(createSession).toHaveBeenCalledWith(
      employee,
      metadata,
      undefined,
      employee.password,
    );
  });

  it('does not create a session when password verification fails', async () => {
    jest.spyOn(employees, 'getEmployee').mockResolvedValue({
      id: 'employee-1',
      email: 'owner@example.com',
      password: 'password-hash',
      isActive: true,
    } as never);
    const compare = jest
      .spyOn(passwordHash, 'compare')
      .mockResolvedValue(false);
    const createSession = jest.spyOn(sessions, 'createSession');

    await expect(
      service.signIn({ email: 'owner@example.com', password: 'incorrect' }, {}),
    ).rejects.toThrow(AUTH_ERRORS.INVALID_CREDENTIALS);
    expect(compare).toHaveBeenCalledWith('incorrect', 'password-hash');
    expect(createSession).not.toHaveBeenCalled();
  });

  it('keeps public Google login generic and never provisions a staff account', async () => {
    const findFirst = jest.fn().mockResolvedValue(null);
    const create = jest.fn();
    Object.assign(prisma, { employee: { findFirst, create } });
    jest
      .spyOn(google, 'verify')
      .mockResolvedValue({ subject: 'subject', email: 'staff@example.com' });
    const createSession = jest.spyOn(sessions, 'createSession');

    await expect(
      service.signInWithGoogle({ idToken: 'token' }, {}),
    ).rejects.toThrow(AUTH_ERRORS.INVALID_CREDENTIALS);
    expect(create).not.toHaveBeenCalled();
    expect(createSession).not.toHaveBeenCalled();
  });

  it.each([
    ['GOOGLE_EMAIL_MISMATCH', 'other@example.com', null],
    ['GOOGLE_ALREADY_LINKED', 'staff@example.com', 'other-subject'],
  ])(
    'returns %s for an authenticated account without changing its link',
    async (code, email, googleSubject) => {
      const transaction = jest.fn();
      Object.assign(prisma, {
        employee: {
          findUnique: jest.fn().mockResolvedValue({
            id: 'employee-1',
            email,
            password: 'hash',
            isActive: true,
            googleSubject,
          }),
        },
        $transaction: transaction,
      });
      jest.spyOn(passwordHash, 'compare').mockResolvedValue(true);
      jest
        .spyOn(google, 'verify')
        .mockResolvedValue({ subject: 'subject', email: 'staff@example.com' });

      await expect(
        service.linkGoogle('employee-1', {
          idToken: 'token',
          password: 'password',
        }),
      ).rejects.toMatchObject({ status: 400, response: { code } });
      expect(transaction).not.toHaveBeenCalled();
    },
  );

  it.each(['link', 'unlink'] as const)(
    'rejects a stale %s without committing audit or session changes',
    async (operation) => {
      const tx = {
        employee: { updateMany: jest.fn().mockResolvedValue({ count: 0 }) },
        actionLog: { create: jest.fn() },
        authSession: { updateMany: jest.fn() },
      };
      Object.assign(prisma, {
        employee: {
          findUnique: jest.fn().mockResolvedValue({
            id: 'employee-1',
            email: 'staff@example.com',
            password: 'hash',
            isActive: true,
            googleSubject: operation === 'unlink' ? 'subject' : null,
          }),
        },
        $transaction: jest.fn(
          (callback: (client: typeof tx) => Promise<unknown>) => callback(tx),
        ),
      });
      jest.spyOn(passwordHash, 'compare').mockResolvedValue(true);
      jest
        .spyOn(google, 'verify')
        .mockResolvedValue({ subject: 'subject', email: 'staff@example.com' });
      const result =
        operation === 'link'
          ? service.linkGoogle('employee-1', {
              idToken: 'token',
              password: 'password',
            })
          : service.unlinkGoogle('employee-1', { password: 'password' });

      await expect(result).rejects.toMatchObject({
        status: 400,
        response: { code: 'GOOGLE_LINK_CHANGED' },
      });
      expect(tx.actionLog.create).not.toHaveBeenCalled();
      expect(tx.authSession.updateMany).not.toHaveBeenCalled();
    },
  );

  it('maps a concurrent unique-link conflict to the same safe already-linked code', async () => {
    Object.assign(prisma, {
      employee: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'employee-1',
          email: 'staff@example.com',
          password: 'hash',
          isActive: true,
          googleSubject: null,
        }),
      },
      $transaction: jest.fn().mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError('unique', {
          code: 'P2002',
          clientVersion: 'test',
        }),
      ),
    });
    jest.spyOn(passwordHash, 'compare').mockResolvedValue(true);
    jest
      .spyOn(google, 'verify')
      .mockResolvedValue({ subject: 'subject', email: 'staff@example.com' });

    await expect(
      service.linkGoogle('employee-1', {
        idToken: 'token',
        password: 'password',
      }),
    ).rejects.toMatchObject({
      status: 400,
      response: { code: 'GOOGLE_ALREADY_LINKED' },
    });
  });
});
