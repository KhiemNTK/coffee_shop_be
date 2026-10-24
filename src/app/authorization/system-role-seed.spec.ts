import {
  assertSystemRoleOwnership,
  upsertSystemRole,
} from '../../../prisma/system-role-seed';

describe('System role seed ownership', () => {
  const seed = { name: 'OWNER', description: 'System owner' };
  const fixture = () => ({
    role: {
      findFirst: jest.fn().mockResolvedValue(null),
      create: jest.fn(),
      update: jest.fn(),
    },
  });

  it('fails preflight if any reserved name belongs to a custom role', () => {
    expect(() =>
      assertSystemRoleOwnership([
        { name: 'OWNER', isSystemRole: true },
        { name: 'MANAGER', isSystemRole: false },
      ]),
    ).toThrow('MANAGER');
  });

  it('does not take over a custom role, including one created after preflight', async () => {
    const prisma = fixture();
    prisma.role.findFirst.mockResolvedValue({
      id: 'custom',
      name: 'OWNER',
      isSystemRole: false,
    });
    await expect(upsertSystemRole(prisma as never, seed)).rejects.toThrow(
      'Rename them explicitly',
    );
    expect(prisma.role.update).not.toHaveBeenCalled();
    expect(prisma.role.create).not.toHaveBeenCalled();
  });

  it('creates a system role or updates only an already-owned active system role', async () => {
    const prisma = fixture();
    await upsertSystemRole(prisma as never, seed);
    expect(prisma.role.create).toHaveBeenCalledWith({
      data: { ...seed, isSystemRole: true },
    });
    prisma.role.findFirst.mockResolvedValue({
      id: 'system',
      name: 'OWNER',
      isSystemRole: true,
    });
    await upsertSystemRole(prisma as never, seed);
    expect(prisma.role.update).toHaveBeenCalledWith({
      where: { id: 'system', isSystemRole: true, deletedAt: null },
      data: { description: seed.description },
    });
  });
});
