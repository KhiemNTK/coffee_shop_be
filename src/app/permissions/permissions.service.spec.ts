import { BadRequestException } from '@nestjs/common';
import type { ExtendedPrismaClient } from '../../common/prisma/prisma.service';
import type { PaginationUtilService } from '../../common/utils/pagination-util/pagination-util.service';
import type { QueryUtilService } from '../../common/utils/query-util/query-util.service';
import { PermissionsService } from './permissions.service';

describe('PermissionsService deletion', () => {
  const tx = {
    rolePermission: { deleteMany: jest.fn() },
    permission: { update: jest.fn() },
  };
  const prisma = {
    permission: { findUnique: jest.fn() },
    $transaction: jest.fn(),
  };
  const service = new PermissionsService(
    prisma as unknown as ExtendedPrismaClient,
    {} as PaginationUtilService,
    {} as QueryUtilService,
  );

  beforeEach(() => {
    jest.resetAllMocks();
    prisma.permission.findUnique.mockResolvedValue({
      id: 'permission-id',
      isSystemPermission: false,
    });
    prisma.$transaction.mockImplementation(
      (callback: (client: typeof tx) => unknown) => callback(tx),
    );
  });

  it('cleans up junctions and soft-deletes through the same transaction', async () => {
    await service.deletePermission('permission-id');
    expect(tx.rolePermission.deleteMany).toHaveBeenCalledWith({
      where: { permissionId: 'permission-id' },
    });
    expect(tx.permission.update).toHaveBeenCalledWith({
      where: { id: 'permission-id' },
      data: { deletedAt: expect.any(Date) },
    });
  });

  it('propagates transaction failures', async () => {
    tx.permission.update.mockRejectedValue(new Error('rollback'));
    await expect(service.deletePermission('permission-id')).rejects.toThrow(
      'rollback',
    );
  });

  it('does not delete a system permission', async () => {
    prisma.permission.findUnique.mockResolvedValue({
      isSystemPermission: true,
    });
    await expect(
      service.deletePermission('permission-id'),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
});
