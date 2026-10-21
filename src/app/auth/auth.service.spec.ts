import { TestingModule } from '@nestjs/testing';
import { AUTH_ERRORS } from '../../common/consts/message';
import { PasswordHashService } from '../../common/utils/password-hash/password-hash.service';
import { EmployeesService } from '../employees/employees.service';
import { AuthSessionService } from './auth-session.service';
import { AuthService } from './auth.service';
import { AutoMockingModule } from '../../../test/auto-mocking/auto-mocking.module';
import { AuthModule } from './auth.module';

describe('AuthService', () => {
  let service: AuthService;
  let employees: EmployeesService;
  let passwordHash: PasswordHashService;
  let sessions: AuthSessionService;

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
});
