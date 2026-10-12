import { PrismaService } from './prisma.service';

describe('Prisma soft deletion boundary', () => {
  const prisma = new PrismaService();
  let intercept: (input: {
    model: string;
    operation: string;
    args: object;
    query: jest.Mock;
  }) => Promise<unknown>;

  beforeEach(() => {
    jest.spyOn(prisma, '$extends').mockImplementation((extension: any) => {
      intercept = extension.query.$allModels.$allOperations;
      return {};
    });
    prisma.getExtendedClient();
  });

  afterEach(() => jest.restoreAllMocks());

  it.each(['delete', 'deleteMany'])(
    'rejects %s on soft-delete models without dispatching a base query',
    async (operation) => {
      const query = jest.fn();
      const update = jest.spyOn(prisma.permission, 'update');
      const updateMany = jest.spyOn(prisma.permission, 'updateMany');
      await expect(
        intercept({ model: 'Permission', operation, args: {}, query }),
      ).rejects.toThrow('use update/updateMany with deletedAt');
      expect(query).not.toHaveBeenCalled();
      expect(update).not.toHaveBeenCalled();
      expect(updateMany).not.toHaveBeenCalled();
    },
  );

  it('keeps explicit soft deletion on the transaction-bound query', async () => {
    const args = {
      where: { id: 'permission-id' },
      data: { deletedAt: new Date() },
    };
    const query = jest.fn().mockResolvedValue({ id: 'permission-id' });
    await intercept({ model: 'Permission', operation: 'update', args, query });
    expect(query).toHaveBeenCalledWith(args);
  });

  it('preserves hard deletion for junction models without deletedAt', async () => {
    const args = { where: { permissionId: 'permission-id' } };
    const query = jest.fn().mockResolvedValue({ count: 1 });
    await intercept({
      model: 'RolePermission',
      operation: 'deleteMany',
      args,
      query,
    });
    expect(query).toHaveBeenCalledWith(args);
  });
});
