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

describe('Role import validation', () => {
  let service: RolesService;
  let prisma: { role: { createMany: jest.Mock } };
  let excel: { read: jest.Mock };
  const input: ImportRolesDto = {
    file: { buffer: Buffer.from('fixture') } as File,
    employee: {} as never,
  };

  beforeEach(() => {
    prisma = {
      role: { createMany: jest.fn().mockResolvedValue({ count: 1 }) },
    };
    excel = {
      read: jest.fn().mockResolvedValue({ RoleEntity: [{ name: 'WAITER' }] }),
    };
    service = new RolesService(
      prisma as never,
      {} as never,
      {} as never,
      excel as never,
      {} as never,
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
        },
      ],
    });

    await expect(service.importRoles(input)).resolves.toEqual({
      success: true,
      message: 'Imported 1 roles successfully.',
    });
    expect(prisma.role.createMany).toHaveBeenCalledTimes(1);
    expect(prisma.role.createMany).toHaveBeenCalledWith({
      data: [
        {
          name: 'CUSTOM',
          description: 'Service role',
          isSystemRole: false,
          deletedAt: null,
        },
      ],
      skipDuplicates: true,
    });
  });

  it('accepts nullable and absent descriptions in one bulk insert', async () => {
    excel.read.mockResolvedValue({
      RoleEntity: [{ name: 'FIRST', description: null }, { name: 'SECOND' }],
    });
    await service.importRoles(input);
    expect(prisma.role.createMany).toHaveBeenCalledWith({
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
    expect(prisma.role.createMany).not.toHaveBeenCalled();
  });

  it.each([{}, { RoleEntity: [] }, { OtherSheet: [{ name: 'CUSTOM' }] }])(
    'retains missing/empty sheet validation: %p',
    async (sheets) => {
      excel.read.mockResolvedValue(sheets);
      await expect(service.importRoles(input)).rejects.toThrow(
        "Sheet 'RoleEntity' is empty or not found",
      );
      expect(prisma.role.createMany).not.toHaveBeenCalled();
    },
  );

  it('propagates parser rejection without writing', async () => {
    const error = new BadRequestException('Excel data row limit exceeded.');
    excel.read.mockRejectedValue(error);
    await expect(service.importRoles(input)).rejects.toBe(error);
    expect(prisma.role.createMany).not.toHaveBeenCalled();
  });

  it('propagates database errors', async () => {
    const error = new Error('Database unavailable');
    prisma.role.createMany.mockRejectedValue(error);
    await expect(service.importRoles(input)).rejects.toBe(error);
    expect(prisma.role.createMany).toHaveBeenCalledTimes(1);
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
      {} as never,
    );
    await importer.importRoles({
      ...input,
      file: { buffer: Buffer.from(await workbook.xlsx.writeBuffer()) } as File,
    });
    expect(prisma.role.createMany).toHaveBeenCalledWith({
      data: [
        {
          name: 'CUSTOM',
          description: undefined,
          isSystemRole: false,
          deletedAt: null,
        },
      ],
      skipDuplicates: true,
    });
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
        deleteMany: jest.fn(),
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
    expect(tx.employeeRole.deleteMany).not.toHaveBeenCalled();
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
});
