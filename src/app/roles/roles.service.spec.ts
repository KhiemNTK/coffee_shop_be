import { AutoMockingModule } from '../../../test/auto-mocking/auto-mocking.module';
import { RolesModule } from './roles.module';
import { RolesService } from './roles.service';
import { AuthorizationService } from '../authorization/authorization.service';
import { PermissionKeys } from '../../common/consts/permission-keys';
import { AUTHORIZATION_ERRORS } from '../../common/consts/message';
import { BadRequestException } from '@nestjs/common';
import { ExcelUtilService } from '../../common/utils/excel-util/excel-util.service';
import type { ImportRolesDto } from './dto';
import type { File } from '../../common/utils/excel-util/dto/excel-util.interface';
import { QueryUtilService } from '../../common/utils/query-util/query-util.service';
import { PaginationUtilService } from '../../common/utils/pagination-util/pagination-util.service';

describe('RoleService', () => {
  let service: RolesService;

  beforeEach(async () => {
    const module = await AutoMockingModule.createTestingModule({
      imports: [RolesModule],
    });

    service = await module.resolve<RolesService>(RolesService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });
});

describe('Role export boundary', () => {
  const prisma = { role: { findMany: jest.fn() } };
  const service = new RolesService(
    prisma as never,
    new PaginationUtilService(),
    new QueryUtilService(),
    new ExcelUtilService(),
    {} as never,
  );

  beforeEach(() => {
    jest.clearAllMocks();
    prisma.role.findMany.mockResolvedValue([
      { name: 'CUSTOM', description: 'Service role' },
    ]);
  });

  it('defaults to scalar metadata without role or employee assignments', async () => {
    const workbook = await service.exportRoles({ ids: null, select: null });
    expect(prisma.role.findMany).toHaveBeenCalledWith({
      where: {},
      select: {
        name: true,
        description: true,
        isSystemRole: true,
        createdAt: true,
        updatedAt: true,
      },
      orderBy: [{ name: 'asc' }, { id: 'asc' }],
    });
    expect(workbook.worksheets[0].columns.map((column) => column.key)).toEqual([
      'name',
      'description',
    ]);
  });

  it('retains explicit metadata selection and ID filtering', async () => {
    await service.exportRoles({ ids: ['role-id'], select: 'name,description' });
    expect(prisma.role.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: { in: ['role-id'] } },
        select: { name: true, description: true },
      }),
    );
  });

  it.each(['rolePermissions', 'employeeRoles', 'password'])(
    'rejects forbidden export selection: %s',
    async (select) => {
      await expect(
        service.exportRoles({ ids: null, select }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.role.findMany).not.toHaveBeenCalled();
    },
  );
});

describe('Role import validation', () => {
  let service: RolesService;
  let prisma: {
    role: { createManyAndReturn: jest.Mock };
    actionLog: { create: jest.Mock };
    $transaction: jest.Mock;
  };
  let excel: { read: jest.Mock };
  const input: ImportRolesDto = {
    file: { buffer: Buffer.from('fixture') } as File,
    employee: { employeeId: 'actor' },
  };
  const authorization = {
    getFreshAuthorizationContext: jest.fn().mockResolvedValue({}),
    assertCanGrantPermissions: jest.fn(),
  };

  beforeEach(() => {
    prisma = {
      role: {
        createManyAndReturn: jest
          .fn()
          .mockResolvedValue([
            { id: 'imported', name: 'CUSTOM', description: 'Service role' },
          ]),
      },
      actionLog: { create: jest.fn() },
      $transaction: jest.fn((callback) => callback(prisma)),
    };
    excel = {
      read: jest.fn().mockResolvedValue({ RoleEntity: [{ name: 'WAITER' }] }),
    };
    service = new RolesService(
      prisma as never,
      {} as never,
      {} as never,
      excel as never,
      authorization as never,
    );
  });

  it('only imports schema fields and assigns protected fields on the server', async () => {
    excel.read.mockResolvedValue({
      RoleEntity: [
        {
          name: ' CUSTOM ',
          description: ' Service role ',
          id: 'chosen-by-client',
          isSystemRole: true,
          deletedAt: new Date(),
          createdAt: new Date(0),
          updatedAt: new Date(0),
          rolePermissions: { create: [{ permissionId: 'admin' }] },
          employeeRoles: { create: [{ employeeId: 'attacker' }] },
          templateRoleId: 'untrusted-template',
        },
      ],
    });

    await expect(service.importRoles(input)).resolves.toEqual({
      success: true,
      message: 'Imported 1 roles successfully.',
    });
    expect(prisma.role.createManyAndReturn).toHaveBeenCalledTimes(1);
    expect(prisma.role.createManyAndReturn).toHaveBeenCalledWith({
      data: [
        {
          name: 'CUSTOM',
          description: 'Service role',
          isSystemRole: false,
          deletedAt: null,
        },
      ],
      skipDuplicates: true,
      select: { id: true, name: true, description: true },
    });
    expect(prisma.actionLog.create).toHaveBeenCalledWith({
      data: {
        employeeId: 'actor',
        actionType: 'ROLES_IMPORTED',
        details: {
          before: null,
          after: [
            { id: 'imported', name: 'CUSTOM', description: 'Service role' },
          ],
        },
      },
    });
  });

  it('accepts nullable and absent descriptions in one bulk insert', async () => {
    excel.read.mockResolvedValue({
      RoleEntity: [{ name: 'FIRST', description: null }, { name: 'SECOND' }],
    });
    await service.importRoles(input);
    expect(prisma.role.createManyAndReturn).toHaveBeenCalledWith({
      data: [
        {
          name: 'FIRST',
          description: null,
          isSystemRole: false,
          deletedAt: null,
        },
        {
          name: 'SECOND',
          description: undefined,
          isSystemRole: false,
          deletedAt: null,
        },
      ],
      skipDuplicates: true,
      select: { id: true, name: true, description: true },
    });
  });

  it.each([
    {},
    { name: '   ' },
    { name: 42 },
    { name: 'x'.repeat(101) },
    { name: 'CUSTOM', description: 'x'.repeat(501) },
    { name: 'CUSTOM', description: false },
    { name: { formula: '"ADMIN"', result: 'ADMIN' } },
    null,
  ])('validates every row before any database write: %p', async (row) => {
    excel.read.mockResolvedValue({ RoleEntity: [{ name: 'VALID' }, row] });
    await expect(service.importRoles(input)).rejects.toThrow(
      "Invalid role in sheet 'RoleEntity' at row 3.",
    );
    expect(prisma.role.createManyAndReturn).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it.each([{}, { RoleEntity: [] }, { OtherSheet: [{ name: 'CUSTOM' }] }])(
    'retains missing/empty sheet validation: %p',
    async (sheets) => {
      excel.read.mockResolvedValue(sheets);
      await expect(service.importRoles(input)).rejects.toThrow(
        "Sheet 'RoleEntity' is empty or not found",
      );
      expect(prisma.role.createManyAndReturn).not.toHaveBeenCalled();
    },
  );

  it('propagates parser rejection without writing', async () => {
    const error = new BadRequestException('Excel data row limit exceeded.');
    excel.read.mockRejectedValue(error);
    await expect(service.importRoles(input)).rejects.toBe(error);
    expect(prisma.role.createManyAndReturn).not.toHaveBeenCalled();
  });

  it('propagates database errors', async () => {
    const error = new Error('Database unavailable');
    prisma.role.createManyAndReturn.mockRejectedValue(error);
    await expect(service.importRoles(input)).rejects.toBe(error);
    expect(prisma.role.createManyAndReturn).toHaveBeenCalledTimes(1);
    expect(prisma.actionLog.create).not.toHaveBeenCalled();
  });

  it('does not audit skipped duplicates or hide an audit failure', async () => {
    prisma.role.createManyAndReturn.mockResolvedValueOnce([]);
    await expect(service.importRoles(input)).resolves.toMatchObject({
      message: 'Imported 0 roles successfully.',
    });
    expect(prisma.actionLog.create).not.toHaveBeenCalled();
    prisma.actionLog.create.mockRejectedValueOnce(
      new Error('Audit unavailable'),
    );
    await expect(service.importRoles(input)).rejects.toThrow(
      'Audit unavailable',
    );
  });

  it('does not import protected fields from real normalized Excel headers', async () => {
    const excelUtil = new ExcelUtilService();
    const workbook = excelUtil.generateExcel({
      worksheets: [
        {
          sheetName: 'RoleEntity',
          fieldsExclude: [],
          data: [
            {
              name: ' CUSTOM ',
              id: 'client-id',
              isSystemRole: true,
              deletedAt: '2026-01-01',
              createdAt: '2000-01-01',
            },
          ],
        },
      ],
    });
    const importer = new RolesService(
      prisma as never,
      {} as never,
      {} as never,
      excelUtil,
      authorization as never,
    );
    await importer.importRoles({
      ...input,
      file: { buffer: Buffer.from(await workbook.xlsx.writeBuffer()) } as File,
    });
    expect(prisma.role.createManyAndReturn).toHaveBeenCalledWith({
      data: [
        {
          name: 'CUSTOM',
          description: undefined,
          isSystemRole: false,
          deletedAt: null,
        },
      ],
      skipDuplicates: true,
      select: { id: true, name: true, description: true },
    });
  });
});

describe('Role metadata and templates', () => {
  const metadata = {
    id: 'role',
    name: 'Custom',
    description: null,
    isSystemRole: false,
  };
  function fixture() {
    const tx = {
      $queryRaw: jest.fn().mockResolvedValue([
        {
          employeeId: 'actor',
          employeeEmail: 'actor@example.test',
          roleNames: [],
          permissionKeys: Object.values(PermissionKeys),
        },
      ]),
      role: {
        findFirst: jest.fn().mockResolvedValue(null),
        findUnique: jest.fn().mockResolvedValue(metadata),
        create: jest.fn().mockResolvedValue(metadata),
        update: jest.fn().mockResolvedValue({ ...metadata, name: 'Renamed' }),
      },
      actionLog: { create: jest.fn() },
    };
    const prisma = { ...tx, $transaction: jest.fn((callback) => callback(tx)) };
    return {
      tx,
      service: new RolesService(
        prisma as never,
        {} as never,
        {} as never,
        {} as never,
        new AuthorizationService(prisma as never),
      ),
    };
  }

  it('creates an empty custom role and audits its metadata in the transaction', async () => {
    const { tx, service } = fixture();
    await service.createRole({ name: 'Custom' }, 'actor');
    expect(tx.role.create).toHaveBeenCalledWith({
      data: {
        name: 'Custom',
        description: undefined,
        isSystemRole: false,
        rolePermissions: { create: [] },
      },
    });
    expect(tx.actionLog.create).toHaveBeenCalledWith({
      data: {
        employeeId: 'actor',
        actionType: 'ROLE_CREATED',
        details: {
          roleId: 'role',
          templateRoleId: null,
          before: null,
          after: { name: 'Custom', description: null },
          afterPermissionIds: [],
        },
      },
    });
  });

  it('copies active grants without copying system identity or assignments', async () => {
    const { tx, service } = fixture();
    tx.role.findUnique.mockResolvedValue({
      rolePermissions: [
        { permission: { id: 'read', key: PermissionKeys.MENU_READ } },
      ],
    });
    await service.createRole(
      { name: 'Custom', templateRoleId: 'source' },
      'actor',
    );
    expect(tx.role.create).toHaveBeenCalledWith({
      data: {
        name: 'Custom',
        description: undefined,
        isSystemRole: false,
        rolePermissions: { create: [{ permissionId: 'read' }] },
      },
    });
    expect(tx.role.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'source', deletedAt: null },
      }),
    );
    expect(tx.actionLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          details: expect.objectContaining({
            templateRoleId: 'source',
            afterPermissionIds: ['read'],
          }),
        }),
      }),
    );
  });

  it.each([
    [PermissionKeys.ROLES_CREATE],
    [
      PermissionKeys.ROLES_CREATE,
      PermissionKeys.ROLES_READ,
      PermissionKeys.ROLE_PERMISSIONS_READ,
      PermissionKeys.ROLE_PERMISSIONS_UPDATE,
    ],
  ])(
    'rejects template copying with missing action or source-grant authority: %p',
    async (...keys) => {
      const { tx, service } = fixture();
      tx.$queryRaw.mockResolvedValue([
        { employeeId: 'actor', permissionKeys: keys, roleNames: [] },
      ] as never);
      tx.role.findUnique.mockResolvedValue({
        rolePermissions: [
          {
            permission: {
              id: 'refund',
              key: PermissionKeys.PAYMENT_REFUNDS_CREATE,
            },
          },
        ],
      });
      await expect(
        service.createRole(
          { name: 'Custom', templateRoleId: 'source' },
          'actor',
        ),
      ).rejects.toThrow(AUTHORIZATION_ERRORS.GRANT_OUTSIDE_SCOPE);
      expect(tx.role.create).not.toHaveBeenCalled();
      expect(tx.actionLog.create).not.toHaveBeenCalled();
    },
  );

  it('rejects missing/deleted templates and active name collisions before writing', async () => {
    const { tx, service } = fixture();
    tx.role.findUnique.mockResolvedValue(null);
    await expect(
      service.createRole(
        { name: 'Custom', templateRoleId: 'missing' },
        'actor',
      ),
    ).rejects.toThrow('Role not found');
    tx.role.findFirst.mockResolvedValue({ id: 'existing' });
    await expect(
      service.createRole({ name: 'Custom' }, 'actor'),
    ).rejects.toThrow(AUTHORIZATION_ERRORS.ROLE_NAME_EXISTS);
    expect(tx.role.create).not.toHaveBeenCalled();
  });

  it('rejects a template changed since preview without creating an empty or partial role', async () => {
    const { tx, service } = fixture();
    tx.role.findUnique.mockResolvedValue({
      rolePermissions: [
        { permission: { id: 'read', key: PermissionKeys.MENU_READ } },
      ],
    });
    await expect(
      service.createRole(
        { name: 'Custom', templateRoleId: 'source', expectedPermissionIds: [] },
        'actor',
      ),
    ).rejects.toMatchObject({ response: { code: 'AUTHORIZATION_CHANGED' } });
    expect(tx.role.create).not.toHaveBeenCalled();
  });

  it('updates only metadata, auditing before/after without touching grants', async () => {
    const { tx, service } = fixture();
    await service.updateRole('role', { name: 'Renamed' }, 'actor');
    expect(tx.role.update).toHaveBeenCalledWith({
      where: { id: 'role', deletedAt: null },
      data: { name: 'Renamed', description: undefined },
    });
    expect(tx.actionLog.create).toHaveBeenCalledWith({
      data: {
        employeeId: 'actor',
        actionType: 'ROLE_UPDATED',
        details: {
          roleId: 'role',
          before: { name: 'Custom', description: null },
          after: { name: 'Renamed', description: null },
        },
      },
    });
  });

  it('protects system metadata and does not audit unchanged metadata', async () => {
    const { tx, service } = fixture();
    await service.updateRole('role', { name: 'Custom' }, 'actor');
    expect(tx.role.update).not.toHaveBeenCalled();
    expect(tx.actionLog.create).not.toHaveBeenCalled();
    tx.role.findUnique.mockResolvedValue({ ...metadata, isSystemRole: true });
    await expect(
      service.updateRole('role', { name: 'Renamed' }, 'actor'),
    ).rejects.toThrow(AUTHORIZATION_ERRORS.SYSTEM_ROLE_CANNOT_BE_MODIFIED);
  });

  it('does not report success when the transactional audit fails', async () => {
    const { tx, service } = fixture();
    tx.actionLog.create.mockRejectedValue(new Error('Audit unavailable'));
    await expect(
      service.createRole({ name: 'Custom' }, 'actor'),
    ).rejects.toThrow('Audit unavailable');
    await expect(
      service.updateRole('role', { name: 'Renamed' }, 'actor'),
    ).rejects.toThrow('Audit unavailable');
  });
});

describe('Role permission delegation', () => {
  const allowedKeys = [
    PermissionKeys.ROLE_PERMISSIONS_UPDATE,
    PermissionKeys.ROLES_DELETE,
    PermissionKeys.MENU_READ,
  ];
  let tx: ReturnType<typeof fixture>['tx'];
  let service: RolesService;
  function fixture() {
    const tx = {
      $queryRaw: jest.fn().mockResolvedValue([
        {
          employeeId: 'actor',
          employeeEmail: 'actor@example.test',
          roleNames: ['CUSTOM_ADMIN'],
          permissionKeys: allowedKeys,
        },
      ]),
      role: {
        findFirst: jest.fn().mockResolvedValue(null),
        findUnique: jest.fn().mockResolvedValue({
          id: 'role',
          name: 'CUSTOM',
          isSystemRole: false,
          rolePermissions: [
            { permission: { id: 'read', key: PermissionKeys.MENU_READ } },
          ],
        }),
        update: jest.fn(),
      },
      permission: {
        findMany: jest
          .fn()
          .mockResolvedValue([{ id: 'read', key: PermissionKeys.MENU_READ }]),
      },
      employeeRole: {
        findUnique: jest.fn().mockResolvedValue(null),
        findFirst: jest.fn().mockResolvedValue(null),
      },
      rolePermission: { deleteMany: jest.fn(), createMany: jest.fn() },
      actionLog: { create: jest.fn() },
    };
    const prisma = {
      ...tx,
      $transaction: jest.fn(
        (callback: (client: typeof tx) => Promise<unknown>) => callback(tx),
      ),
    };
    const authorization = new AuthorizationService(prisma as never);
    return {
      tx,
      service: new RolesService(
        prisma as never,
        {} as never,
        {} as never,
        {} as never,
        authorization,
      ),
    };
  }
  beforeEach(() => ({ tx, service } = fixture()));

  it('rejects new permissions outside the actor scope', async () => {
    tx.permission.findMany.mockResolvedValueOnce([
      { id: 'refund', key: PermissionKeys.PAYMENT_REFUNDS_CREATE },
    ]);
    await expect(
      service.replaceRolePermissions(
        'role',
        { permissionIds: ['refund'] },
        'actor',
      ),
    ).rejects.toThrow(AUTHORIZATION_ERRORS.GRANT_OUTSIDE_SCOPE);
    expect(tx.rolePermission.deleteMany).not.toHaveBeenCalled();
  });

  it('cannot strip or delete a higher-privilege custom role', async () => {
    tx.role.findUnique.mockResolvedValue({
      id: 'role',
      name: 'CUSTOM',
      isSystemRole: false,
      rolePermissions: [
        {
          permission: {
            id: 'refund',
            key: PermissionKeys.PAYMENT_REFUNDS_CREATE,
          },
        },
      ],
    });
    await expect(
      service.replaceRolePermissions('role', { permissionIds: [] }, 'actor'),
    ).rejects.toThrow(AUTHORIZATION_ERRORS.GRANT_OUTSIDE_SCOPE);
    await expect(service.deleteRole('role', 'actor')).rejects.toThrow(
      AUTHORIZATION_ERRORS.GRANT_OUTSIDE_SCOPE,
    );
    expect(tx.role.update).not.toHaveBeenCalled();
  });

  it('cannot rewrite or delete a role assigned to the actor', async () => {
    tx.employeeRole.findUnique.mockResolvedValue({ roleId: 'role' });
    await expect(
      service.replaceRolePermissions('role', { permissionIds: [] }, 'actor'),
    ).rejects.toThrow(AUTHORIZATION_ERRORS.SELF_ACCESS_CHANGE);
    await expect(service.deleteRole('role', 'actor')).rejects.toThrow(
      AUTHORIZATION_ERRORS.SELF_ACCESS_CHANGE,
    );
  });

  it('preserves system-role protection', async () => {
    tx.role.findUnique.mockResolvedValue({
      id: 'role',
      name: 'WAITER',
      isSystemRole: true,
      rolePermissions: [],
    });
    await expect(
      service.replaceRolePermissions('role', { permissionIds: [] }, 'actor'),
    ).rejects.toThrow(AUTHORIZATION_ERRORS.SYSTEM_ROLE_CANNOT_BE_MODIFIED);
  });

  it('rejects duplicate/missing IDs and treats identical replacements as no-ops', async () => {
    await expect(
      service.replaceRolePermissions(
        'role',
        { permissionIds: ['read', 'read'] },
        'actor',
      ),
    ).rejects.toThrow(AUTHORIZATION_ERRORS.DUPLICATE_PERMISSION_IDS);
    tx.permission.findMany.mockResolvedValueOnce([]);
    await expect(
      service.replaceRolePermissions(
        'role',
        { permissionIds: ['missing'] },
        'actor',
      ),
    ).rejects.toThrow(AUTHORIZATION_ERRORS.INVALID_PERMISSION_IDS);
    await service.replaceRolePermissions(
      'role',
      { permissionIds: ['read'] },
      'actor',
    );
    expect(tx.rolePermission.deleteMany).not.toHaveBeenCalled();
    expect(tx.actionLog.create).not.toHaveBeenCalled();
  });

  it('writes permission before/after and actor into the transactional audit', async () => {
    tx.permission.findMany.mockResolvedValue([]);
    await service.replaceRolePermissions(
      'role',
      { permissionIds: [] },
      'actor',
    );
    expect(tx.actionLog.create).toHaveBeenCalledWith({
      data: {
        employeeId: 'actor',
        actionType: 'ROLE_PERMISSIONS_REPLACED',
        details: {
          roleId: 'role',
          beforePermissionIds: ['read'],
          afterPermissionIds: [],
        },
      },
    });
  });

  it('rejects a stale permission baseline before changing junctions or auditing', async () => {
    tx.permission.findMany.mockResolvedValue([]);
    await expect(
      service.replaceRolePermissions(
        'role',
        {
          permissionIds: [],
          expectedPermissionIds: [],
        },
        'actor',
      ),
    ).rejects.toMatchObject({
      response: { code: 'AUTHORIZATION_CHANGED' },
    });
    expect(tx.rolePermission.deleteMany).not.toHaveBeenCalled();
    expect(tx.actionLog.create).not.toHaveBeenCalled();
  });

  it('accepts a matching baseline and a replay of an already-applied replacement', async () => {
    await service.replaceRolePermissions(
      'role',
      {
        permissionIds: ['read'],
        expectedPermissionIds: [],
      },
      'actor',
    );
    expect(tx.actionLog.create).not.toHaveBeenCalled();
    tx.permission.findMany.mockResolvedValue([]);
    await service.replaceRolePermissions(
      'role',
      {
        permissionIds: [],
        expectedPermissionIds: ['read'],
      },
      'actor',
    );
    expect(tx.rolePermission.deleteMany).toHaveBeenCalledTimes(1);
    expect(tx.actionLog.create).toHaveBeenCalledTimes(1);
  });

  it('soft deletes the role through its transaction delegate', async () => {
    await service.deleteRole('role', 'actor');
    expect(tx.role.update).toHaveBeenCalledWith({
      where: { id: 'role', deletedAt: null },
      data: { deletedAt: expect.any(Date) },
    });
    expect(tx.actionLog.create).toHaveBeenCalled();
  });

  it('blocks deletion while assigned, even to an inactive or deleted employee', async () => {
    tx.employeeRole.findFirst.mockResolvedValue({
      employeeId: 'inactive-employee',
    });
    await expect(service.deleteRole('role', 'actor')).rejects.toMatchObject({
      response: { code: 'ROLE_IN_USE' },
    });
    expect(tx.rolePermission.deleteMany).not.toHaveBeenCalled();
    expect(tx.role.update).not.toHaveBeenCalled();
    expect(tx.actionLog.create).not.toHaveBeenCalled();
  });
});
