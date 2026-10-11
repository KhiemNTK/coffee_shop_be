import { TestingModule } from '@nestjs/testing';
import { EmployeesService } from './employees.service';
import { AutoMockingModule } from '../../../test/auto-mocking/auto-mocking.module';
import { EmployeesModule } from './employees.module';
import { PRISMA_SERVICE_TOKEN } from '../../common/prisma/prisma.service';
import { StringUtilService } from '../../common/utils/string-util/string-util.service';
import { PaginationUtilService } from '../../common/utils/pagination-util/pagination-util.service';
import { GetEmployeesPaginationDto } from './dto';
import { AuthorizationService } from '../authorization/authorization.service';
import { PermissionKeys } from '../../common/consts/permission-keys';
import { AUTH_ERRORS, AUTHORIZATION_ERRORS } from '../../common/consts/message';

describe('EmployeesService', () => {
  let service: EmployeesService;
  let employeeCreate: jest.Mock;
  let stringUtilService: StringUtilService;

  beforeEach(async () => {
    const module: TestingModule = await AutoMockingModule.createTestingModule({
      imports: [EmployeesModule],
    });

    service = module.get<EmployeesService>(EmployeesService);
    stringUtilService = module.get(StringUtilService);
    employeeCreate = jest.fn();
    const prisma = module.get<Record<string, unknown>>(PRISMA_SERVICE_TOKEN);
    prisma.employee = { create: employeeCreate };
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  it('validates paging and preserves false instead of coercing it to true', () => {
    expect(
      GetEmployeesPaginationDto.schema.parse({
        isActive: 'false',
        search: '  cashier  ',
      }),
    ).toMatchObject({
      isActive: false,
      search: 'cashier',
      page: 1,
      itemPerPage: 10,
    });
    for (const input of [
      { isActive: 'invalid' },
      { page: 1.5 },
      { itemPerPage: 101 },
      { positionId: 'invalid' },
    ]) {
      expect(GetEmployeesPaginationDto.schema.safeParse(input).success).toBe(
        false,
      );
    }
  });

  it('combines global search and exact filters before paging with a stable order', async () => {
    const prisma = {
      employee: {
        count: jest.fn().mockResolvedValue(21),
        findMany: jest.fn().mockResolvedValue([{ id: 'employee-21' }]),
      },
    };
    const subject = new EmployeesService(
      prisma as never,
      new PaginationUtilService(),
      {} as never,
      {} as never,
    );
    const positionId = 'a15d0c7c-cfb3-4bd4-a039-25e01184f19d';
    const query = GetEmployeesPaginationDto.schema.parse({
      page: 2,
      itemPerPage: 20,
      search: 'cashier',
      isActive: 'false',
      positionId,
    });
    const result = await subject.getEmployees(query);
    const where = {
      deletedAt: null,
      isActive: false,
      positionId,
      OR: ['fullName', 'username', 'email'].map((field) => ({
        [field]: { contains: 'cashier', mode: 'insensitive' },
      })),
    };
    expect(prisma.employee.count).toHaveBeenCalledWith({ where });
    expect(prisma.employee.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where,
        skip: 20,
        take: 20,
        orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
      }),
    );
    expect(result).toMatchObject({
      currentPage: 2,
      totalItems: 21,
      totalPages: 2,
    });
    expect(prisma.employee.findMany.mock.calls[0][0].select).not.toHaveProperty(
      'password',
    );
  });

  it('hashes a password before creating an employee', async () => {
    jest.spyOn(stringUtilService, 'hash').mockResolvedValue('password-hash');
    employeeCreate.mockResolvedValue({ id: 'employee-1' });

    await service.createEmployee({
      email: 'employee@example.com',
      username: 'employee',
      fullName: 'Employee',
      password: 'correct-horse-battery-staple',
      positionId: 'a15d0c7c-cfb3-4bd4-a039-25e01184f19d',
      isActive: true,
    });

    expect(employeeCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ password: 'password-hash' }),
        select: expect.not.objectContaining({ password: true }),
      }),
    );
    expect(employeeCreate.mock.calls[0][0].data.password).not.toBe(
      'correct-horse-battery-staple',
    );
  });
});

describe('Employee access changes', () => {
  const keys = Object.values(PermissionKeys);
  const role = (
    id: string,
    name: string,
    permissions: string[],
    isSystemRole = false,
  ) => ({
    id,
    name,
    description: null,
    isSystemRole,
    rolePermissions: permissions.map((key) => ({ permission: { key } })),
  });
  const ownerRole = role('owner-role', 'OWNER', keys, true);
  const cashierRole = role(
    'cashier-role',
    'CASHIER',
    [PermissionKeys.MENU_READ],
    true,
  );
  let tx: ReturnType<typeof fixture>['tx'];
  let service: EmployeesService;
  let records: Map<string, ReturnType<typeof makeEmployee>>;
  const makeEmployee = (id: string, roles: (typeof ownerRole)[]) => ({
    id,
    email: id + '@example.test',
    fullName: id,
    isActive: true,
    deletedAt: null,
    employeeRoles: roles.map((entry) => ({ role: entry })),
  });
  function fixture() {
    records = new Map([
      ['owner', makeEmployee('owner', [ownerRole])],
      [
        'manager',
        makeEmployee('manager', [
          role(
            'manager-role',
            'MANAGER',
            [
              PermissionKeys.EMPLOYEE_ROLES_UPDATE,
              PermissionKeys.EMPLOYEES_UPDATE,
              PermissionKeys.EMPLOYEES_DELETE,
              PermissionKeys.MENU_READ,
            ],
            true,
          ),
        ]),
      ],
      ['cashier', makeEmployee('cashier', [cashierRole])],
    ]);
    const tx = {
      employee: {
        findUnique: jest.fn(({ where }: { where: { id: string } }) =>
          Promise.resolve(records.get(where.id) ?? null),
        ),
        count: jest.fn().mockResolvedValue(0),
        update: jest.fn(
          ({
            where,
            data,
          }: {
            where: { id: string };
            data: Record<string, unknown>;
          }) => Promise.resolve({ ...records.get(where.id), ...data }),
        ),
      },
      role: { findMany: jest.fn().mockResolvedValue([cashierRole]) },
      employeeRole: { deleteMany: jest.fn(), createMany: jest.fn() },
      authSession: { updateMany: jest.fn() },
      passwordResetToken: { updateMany: jest.fn() },
      actionLog: { create: jest.fn() },
    };
    const prisma = {
      ...tx,
      $transaction: jest.fn(
        (callback: (client: typeof tx) => Promise<unknown>) => callback(tx),
      ),
    };
    const authorization = new AuthorizationService(
      prisma as never,
      { invalidateEmployee: jest.fn() } as never,
    );
    return {
      tx,
      service: new EmployeesService(
        prisma as never,
        new PaginationUtilService(),
        authorization,
        { hash: jest.fn().mockResolvedValue('password-hash') } as never,
      ),
    };
  }
  beforeEach(() => ({ tx, service } = fixture()));

  it('blocks manager grants of OWNER and custom roles with higher permissions', async () => {
    for (const requested of [
      ownerRole,
      role('custom', 'Not called OWNER', [
        PermissionKeys.ROLE_PERMISSIONS_UPDATE,
      ]),
    ]) {
      tx.role.findMany.mockResolvedValueOnce([requested]);
      await expect(
        service.replaceEmployeeRoles(
          'cashier',
          { roleIds: [requested.id] },
          'manager',
        ),
      ).rejects.toThrow(AUTHORIZATION_ERRORS.GRANT_OUTSIDE_SCOPE);
    }
    expect(tx.employeeRole.deleteMany).not.toHaveBeenCalled();
    expect(tx.actionLog.create).not.toHaveBeenCalled();
  });

  it('blocks clearing higher-privilege accounts, password takeover and deletion', async () => {
    await expect(
      service.replaceEmployeeRoles('owner', { roleIds: [] }, 'manager'),
    ).rejects.toThrow(AUTHORIZATION_ERRORS.GRANT_OUTSIDE_SCOPE);
    await expect(
      service.updateEmployee(
        'owner',
        { password: 'another-password' },
        'manager',
      ),
    ).rejects.toThrow(AUTHORIZATION_ERRORS.GRANT_OUTSIDE_SCOPE);
    await expect(service.deleteEmployee('owner', 'manager')).rejects.toThrow(
      AUTHORIZATION_ERRORS.GRANT_OUTSIDE_SCOPE,
    );
    expect(tx.employee.update).not.toHaveBeenCalled();
  });

  it('blocks self access changes', async () => {
    await expect(
      service.replaceEmployeeRoles('owner', { roleIds: [] }, 'owner'),
    ).rejects.toThrow(AUTHORIZATION_ERRORS.SELF_ACCESS_CHANGE);
    await expect(
      service.updateEmployee('owner', { isActive: false }, 'owner'),
    ).rejects.toThrow(AUTHORIZATION_ERRORS.SELF_ACCESS_CHANGE);
    await expect(service.deleteEmployee('owner', 'owner')).rejects.toThrow(
      AUTHORIZATION_ERRORS.SELF_ACCESS_CHANGE,
    );
  });

  it('keeps the last active OWNER even when an actor holds all permissions through another role', async () => {
    records.set(
      'delegate',
      makeEmployee('delegate', [role('delegate-role', 'CUSTOM', keys)]),
    );
    tx.role.findMany.mockResolvedValueOnce([]);
    await expect(
      service.replaceEmployeeRoles('owner', { roleIds: [] }, 'delegate'),
    ).rejects.toThrow(AUTHORIZATION_ERRORS.LAST_OWNER);
    await expect(
      service.updateEmployee('owner', { isActive: false }, 'delegate'),
    ).rejects.toThrow(AUTHORIZATION_ERRORS.LAST_OWNER);
    await expect(service.deleteEmployee('owner', 'delegate')).rejects.toThrow(
      AUTHORIZATION_ERRORS.LAST_OWNER,
    );
    expect(tx.employeeRole.deleteMany).not.toHaveBeenCalled();
  });

  it('rejects duplicate, missing and inactive assignments before writes', async () => {
    await expect(
      service.replaceEmployeeRoles(
        'cashier',
        { roleIds: ['x', 'x'] },
        'manager',
      ),
    ).rejects.toThrow(AUTHORIZATION_ERRORS.DUPLICATE_ROLE_IDS);
    tx.role.findMany.mockResolvedValueOnce([]);
    await expect(
      service.replaceEmployeeRoles(
        'cashier',
        { roleIds: ['missing'] },
        'manager',
      ),
    ).rejects.toThrow(AUTHORIZATION_ERRORS.INVALID_ROLE_IDS);
    records.get('cashier')!.isActive = false;
    await expect(
      service.replaceEmployeeRoles('cashier', { roleIds: [] }, 'manager'),
    ).rejects.toThrow(AUTH_ERRORS.INACTIVE_EMPLOYEE);
    expect(tx.employeeRole.deleteMany).not.toHaveBeenCalled();
  });

  it('does not rewrite or audit an identical role replacement', async () => {
    await service.replaceEmployeeRoles(
      'cashier',
      { roleIds: [cashierRole.id] },
      'manager',
    );
    expect(tx.employeeRole.deleteMany).not.toHaveBeenCalled();
    expect(tx.actionLog.create).not.toHaveBeenCalled();
  });

  it('writes a role-change audit in the same transaction', async () => {
    tx.role.findMany.mockResolvedValue([]);
    await service.replaceEmployeeRoles('cashier', { roleIds: [] }, 'manager');
    expect(tx.actionLog.create).toHaveBeenCalledWith({
      data: {
        employeeId: 'manager',
        actionType: 'EMPLOYEE_ROLES_REPLACED',
        details: {
          employeeId: 'cashier',
          beforeRoleIds: [cashierRole.id],
          afterRoleIds: [],
        },
      },
    });
  });

  it('revokes sessions and reset tokens after credential changes without auditing secrets', async () => {
    await service.updateEmployee(
      'cashier',
      { password: 'new-secret', email: 'new@example.test' },
      'manager',
    );
    expect(tx.authSession.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ revokeReason: 'CREDENTIALS_CHANGED' }),
      }),
    );
    expect(tx.passwordResetToken.updateMany).toHaveBeenCalled();
    const audit = JSON.stringify(tx.actionLog.create.mock.calls);
    expect(audit).not.toContain('new-secret');
    expect(audit).not.toContain('password-hash');
    expect(audit).not.toContain('new@example.test');
  });

  it('soft deletes inside the transaction without the shared delete interceptor', async () => {
    await service.deleteEmployee('cashier', 'manager');
    expect(tx.employee.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { isActive: false, deletedAt: expect.any(Date) },
      }),
    );
    expect(tx.actionLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          actionType: 'EMPLOYEE_DELETED',
          employeeId: 'manager',
        }),
      }),
    );
  });
});
