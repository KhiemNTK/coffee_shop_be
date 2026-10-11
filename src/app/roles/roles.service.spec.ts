import { AutoMockingModule } from '../../../test/auto-mocking/auto-mocking.module';
import { RolesModule } from './roles.module';
import { RolesService } from './roles.service';
import { AuthorizationService } from '../authorization/authorization.service';
import { PermissionKeys } from '../../common/consts/permission-keys';
import { AUTHORIZATION_ERRORS } from '../../common/consts/message';

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
      employee: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'actor',
          email: 'actor@example.test',
          isActive: true,
          deletedAt: null,
          employeeRoles: [
            {
              role: {
                name: 'CUSTOM_ADMIN',
                rolePermissions: allowedKeys.map((key) => ({
                  permission: { key },
                })),
              },
            },
          ],
        }),
      },
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
    const authorization = new AuthorizationService(
      prisma as never,
      { invalidateAll: jest.fn() } as never,
    );
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

  it('soft deletes the role through its transaction delegate', async () => {
    await service.deleteRole('role', 'actor');
    expect(tx.role.update).toHaveBeenCalledWith({
      where: { id: 'role', deletedAt: null },
      data: { deletedAt: expect.any(Date) },
    });
    expect(tx.actionLog.create).toHaveBeenCalled();
  });
});
