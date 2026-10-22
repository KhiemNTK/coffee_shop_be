import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { Prisma, PrismaClient } from '@prisma/client';
import { AuthorizationService } from '../src/app/authorization/authorization.service';
import { EmployeesService } from '../src/app/employees/employees.service';
import {
  PrismaService,
  type ExtendedPrismaClient,
} from '../src/common/prisma/prisma.service';
import { PaginationUtilService } from '../src/common/utils/pagination-util/pagination-util.service';
import { PermissionKeys } from '../src/common/consts/permission-keys';
import { AUTHORIZATION_ERRORS } from '../src/common/consts/message';
import { RolesService } from '../src/app/roles/roles.service';

describe('Authorization delegation (PostgreSQL)', () => {
  let base: PrismaService;
  let prisma: ExtendedPrismaClient;
  let admin: PrismaClient | undefined;
  const databaseName = `authz_${randomUUID().replaceAll('-', '')}_test`;
  const originalUrl = process.env.DATABASE_URL;
  let databaseCreated = false;
  let authorization: AuthorizationService;
  let employees: EmployeesService;
  const ids = {
    manager: randomUUID(),
    cashier: randomUUID(),
    ownerA: randomUUID(),
    ownerB: randomUUID(),
    delegate: randomUUID(),
    ownerRole: randomUUID(),
    cashierRole: randomUUID(),
    waiterRole: randomUUID(),
  };

  beforeAll(async () => {
    const target = new URL(originalUrl ?? '');
    assert(
      process.env.NODE_ENV === 'test' &&
        ['127.0.0.1', 'localhost'].includes(target.hostname) &&
        target.pathname.endsWith('_test'),
      'Only use a dedicated loopback test database.',
    );
    admin = new PrismaClient({ datasources: { db: { url: target.href } } });
    await admin.$executeRawUnsafe(`CREATE DATABASE "${databaseName}"`);
    databaseCreated = true;
    target.pathname = `/${databaseName}`;
    process.env.DATABASE_URL = target.href;
    execFileSync(
      process.execPath,
      [require.resolve('prisma/build/index.js'), 'migrate', 'deploy'],
      { env: process.env, stdio: 'pipe' },
    );
    base = new PrismaService();
    await base.$connect();
    prisma = base.getExtendedClient();
    authorization = new AuthorizationService(prisma);
    employees = new EmployeesService(
      prisma,
      new PaginationUtilService(),
      authorization,
      {} as never,
    );
    const position = await base.position.create({
      data: { name: 'Authz test', salary: 0 },
    });
    await base.permission.createMany({
      data: Object.values(PermissionKeys).map((key) => ({
        key,
        name: key,
        isSystemPermission: true,
      })),
      skipDuplicates: true,
    });
    const permissions = await base.permission.findMany({
      select: { id: true, key: true },
    });
    const createRole = (
      id: string,
      name: string,
      keys: readonly string[],
      isSystemRole: boolean,
    ) =>
      base.role.create({
        data: {
          id,
          name,
          isSystemRole,
          rolePermissions: {
            create: permissions
              .filter((permission) => keys.includes(permission.key))
              .map((permission) => ({ permissionId: permission.id })),
          },
        },
      });
    const managerKeys = [
      PermissionKeys.EMPLOYEE_ROLES_UPDATE,
      PermissionKeys.EMPLOYEES_UPDATE,
      PermissionKeys.EMPLOYEES_DELETE,
      PermissionKeys.MENU_READ,
    ];
    const managerRole = await createRole(
      randomUUID(),
      'MANAGER',
      managerKeys,
      true,
    );
    await createRole(
      ids.ownerRole,
      'OWNER',
      Object.values(PermissionKeys),
      true,
    );
    await createRole(
      ids.cashierRole,
      'CASHIER',
      [PermissionKeys.MENU_READ],
      true,
    );
    await createRole(
      ids.waiterRole,
      'WAITER',
      [PermissionKeys.MENU_READ],
      true,
    );
    const delegateRole = await createRole(
      randomUUID(),
      'Full permissions without owner role',
      Object.values(PermissionKeys),
      false,
    );
    for (const [id, roleId] of [
      [ids.manager, managerRole.id],
      [ids.cashier, ids.cashierRole],
      [ids.ownerA, ids.ownerRole],
      [ids.ownerB, ids.ownerRole],
      [ids.delegate, delegateRole.id],
    ]) {
      await base.employee.create({
        data: {
          id,
          email: id + '@authz-test.example',
          username: id,
          fullName: 'Authz test',
          password: 'test-only',
          positionId: position.id,
          employeeRoles: { create: { roleId } },
        },
      });
    }
  }, 60_000);
  afterAll(async () => {
    if (originalUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = originalUrl;
    await base?.$disconnect();
    try {
      if (databaseCreated && admin) {
        await admin.$executeRaw(
          Prisma.sql`DROP DATABASE ${Prisma.raw(`"${databaseName}"`)} WITH (FORCE)`,
        );
      }
    } finally {
      await admin?.$disconnect();
    }
  });

  it('blocks manager privilege escalation and returns grantable IDs without leaking permission graphs', async () => {
    await expect(
      employees.replaceEmployeeRoles(
        ids.cashier,
        { roleIds: [ids.ownerRole] },
        ids.manager,
      ),
    ).rejects.toThrow(AUTHORIZATION_ERRORS.GRANT_OUTSIDE_SCOPE);
    await expect(
      employees.updateEmployee(
        ids.ownerA,
        { email: 'takeover@example.test' },
        ids.manager,
      ),
    ).rejects.toThrow(AUTHORIZATION_ERRORS.GRANT_OUTSIDE_SCOPE);
    const detail = await employees.getEmployeeRoles(ids.cashier, ids.manager);
    expect(detail.canManageRoles).toBe(true);
    expect(detail.assignableRoleIds).toContain(ids.waiterRole);
    expect(detail.assignableRoleIds).not.toContain(ids.ownerRole);
    expect(detail.employeeRoles[0].role).not.toHaveProperty('rolePermissions');
    expect(
      (await employees.getEmployeeRoles(ids.ownerA, ids.manager))
        .canManageRoles,
    ).toBe(false);
  });

  it('checks the deployed permission catalog without changing database rows', async () => {
    const before = await base.permission.findMany({ orderBy: { key: 'asc' } });
    const output = execFileSync(
      process.execPath,
      [
        require.resolve('ts-node/dist/bin.js'),
        'prisma/preflight/permissions.ts',
      ],
      { env: process.env, encoding: 'utf8' },
    );
    expect(output).toContain(
      `Permission catalog matches code (${Object.keys(PermissionKeys).length} permissions). No data changed.`,
    );
    expect(await base.permission.findMany({ orderBy: { key: 'asc' } })).toEqual(
      before,
    );
  });

  it('does not grant permissions outside the committed PostgreSQL scope', async () => {
    await expect(
      employees.replaceEmployeeRoles(ids.ownerA, { roleIds: [] }, ids.cashier),
    ).rejects.toThrow(AUTHORIZATION_ERRORS.GRANT_OUTSIDE_SCOPE);
  });

  it('rolls back junction changes when the audit insert fails', async () => {
    await base.$executeRaw`ALTER TABLE "ActionLog" ADD CONSTRAINT authz_test_audit_failure CHECK ("actionType" <> 'EMPLOYEE_ROLES_REPLACED')`;
    try {
      await expect(
        employees.replaceEmployeeRoles(
          ids.cashier,
          { roleIds: [ids.waiterRole] },
          ids.manager,
        ),
      ).rejects.toThrow();
      expect(
        await base.employeeRole.findMany({
          where: { employeeId: ids.cashier },
          select: { roleId: true },
        }),
      ).toEqual([{ roleId: ids.cashierRole }]);
    } finally {
      await base.$executeRaw`ALTER TABLE "ActionLog" DROP CONSTRAINT authz_test_audit_failure`;
    }
  });

  it('commits actor and before/after roles with the business change', async () => {
    await employees.replaceEmployeeRoles(
      ids.cashier,
      { roleIds: [ids.waiterRole] },
      ids.manager,
    );
    const audit = await base.actionLog.findFirst({
      where: { employeeId: ids.manager, actionType: 'EMPLOYEE_ROLES_REPLACED' },
    });
    expect(audit?.details).toEqual({
      employeeId: ids.cashier,
      beforeRoleIds: [ids.cashierRole],
      afterRoleIds: [ids.waiterRole],
    });
    await employees.replaceEmployeeRoles(
      ids.cashier,
      { roleIds: [ids.waiterRole] },
      ids.manager,
    );
    expect(
      await base.actionLog.count({
        where: { actionType: 'EMPLOYEE_ROLES_REPLACED' },
      }),
    ).toBe(1);
  });

  it('revokes sessions and outstanding reset tokens when another authorized employee changes email', async () => {
    await base.authSession.create({
      data: {
        employeeId: ids.cashier,
        familyId: randomUUID(),
        refreshTokenHash: randomUUID(),
        expiresAt: new Date(Date.now() + 3600_000),
      },
    });
    await base.passwordResetToken.create({
      data: {
        employeeId: ids.cashier,
        tokenHash: randomUUID(),
        expiresAt: new Date(Date.now() + 3600_000),
      },
    });
    await employees.updateEmployee(
      ids.cashier,
      { email: 'changed@authz-test.example' },
      ids.manager,
    );
    expect(
      await base.authSession.count({
        where: { employeeId: ids.cashier, revokedAt: null },
      }),
    ).toBe(0);
    expect(
      await base.passwordResetToken.count({
        where: { employeeId: ids.cashier, usedAt: null },
      }),
    ).toBe(0);
  });

  it('preserves an active OWNER under concurrent removals', async () => {
    const results = await Promise.allSettled([
      employees.replaceEmployeeRoles(ids.ownerA, { roleIds: [] }, ids.delegate),
      employees.replaceEmployeeRoles(ids.ownerB, { roleIds: [] }, ids.delegate),
    ]);
    expect(
      results.filter((result) => result.status === 'fulfilled'),
    ).toHaveLength(1);
    const rejected = results.find((result) => result.status === 'rejected');
    expect(rejected?.status === 'rejected' && rejected.reason.message).toBe(
      AUTHORIZATION_ERRORS.LAST_OWNER,
    );
    expect(
      await base.employee.count({
        where: {
          isActive: true,
          deletedAt: null,
          employeeRoles: { some: { roleId: ids.ownerRole } },
        },
      }),
    ).toBe(1);
  });

  it('commits only one concurrent employee-role edit from the same baseline', async () => {
    const { positionId } = await base.employee.findUniqueOrThrow({
      where: { id: ids.manager },
      select: { positionId: true },
    });
    const employeeId = randomUUID();
    await base.employee.create({
      data: {
        id: employeeId,
        email: employeeId + '@authz-test.example',
        username: employeeId,
        fullName: 'Concurrent assignment test',
        password: 'test-only',
        positionId,
        employeeRoles: { create: { roleId: ids.cashierRole } },
      },
    });
    const requested = [[ids.waiterRole], []];
    const results = await Promise.allSettled(
      requested.map((roleIds) =>
        employees.replaceEmployeeRoles(
          employeeId,
          {
            roleIds,
            expectedRoleIds: [ids.cashierRole],
          },
          ids.manager,
        ),
      ),
    );
    expect(
      results.filter((result) => result.status === 'fulfilled'),
    ).toHaveLength(1);
    const rejected = results.find((result) => result.status === 'rejected');
    expect(
      rejected?.status === 'rejected' && rejected.reason.getResponse(),
    ).toMatchObject({ code: 'AUTHORIZATION_CHANGED' });
    const winningIds =
      requested[results.findIndex((result) => result.status === 'fulfilled')];
    const assignments = await base.employeeRole.findMany({
      where: { employeeId },
      select: { roleId: true },
    });
    expect(assignments.map((entry) => entry.roleId)).toEqual(winningIds);
    expect(
      await base.actionLog.count({
        where: {
          actionType: 'EMPLOYEE_ROLES_REPLACED',
          details: { path: ['employeeId'], equals: employeeId },
        },
      }),
    ).toBe(1);
  });

  it('commits only one concurrent role-permission edit and keeps its audit atomic', async () => {
    const read = await base.permission.findFirstOrThrow({
      where: { key: PermissionKeys.MENU_READ },
    });
    const inventory = await base.permission.findFirstOrThrow({
      where: { key: PermissionKeys.INVENTORY_READ },
    });
    const role = await base.role.create({
      data: {
        name: 'Concurrent custom role',
        rolePermissions: { create: { permissionId: read.id } },
      },
    });
    const roles = new RolesService(
      prisma,
      new PaginationUtilService(),
      {} as never,
      {} as never,
      authorization,
    );
    const requested = [[inventory.id], []];
    const results = await Promise.allSettled(
      requested.map((permissionIds) =>
        roles.replaceRolePermissions(
          role.id,
          {
            permissionIds,
            expectedPermissionIds: [read.id],
          },
          ids.delegate,
        ),
      ),
    );
    expect(
      results.filter((result) => result.status === 'fulfilled'),
    ).toHaveLength(1);
    const rejected = results.find((result) => result.status === 'rejected');
    expect(
      rejected?.status === 'rejected' && rejected.reason.getResponse(),
    ).toMatchObject({ code: 'AUTHORIZATION_CHANGED' });
    const winningIds =
      requested[results.findIndex((result) => result.status === 'fulfilled')];
    const assignments = await base.rolePermission.findMany({
      where: { roleId: role.id },
      select: { permissionId: true },
    });
    expect(assignments.map((entry) => entry.permissionId)).toEqual(winningIds);
    expect(
      await base.actionLog.count({
        where: {
          actionType: 'ROLE_PERMISSIONS_REPLACED',
          details: { path: ['roleId'], equals: role.id },
        },
      }),
    ).toBe(1);
  });
});
