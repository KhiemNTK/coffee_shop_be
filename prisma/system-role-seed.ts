import type { PrismaClient } from '@prisma/client';

export function assertSystemRoleOwnership(
  roles: Array<{ name: string; isSystemRole: boolean }>,
) {
  const conflicts = roles.filter((role) => !role.isSystemRole);
  if (conflicts.length)
    throw new Error(
      `Custom roles conflict with reserved system names: ${conflicts.map((role) => role.name).join(', ')}. Rename them explicitly before seeding; their permissions and assignments were not changed.`,
    );
}

export async function upsertSystemRole(
  prisma: PrismaClient,
  seed: { name: string; description: string },
) {
  const existing = await prisma.role.findFirst({
    where: { name: seed.name, deletedAt: null },
    select: { id: true, name: true, isSystemRole: true },
  });
  if (existing) {
    assertSystemRoleOwnership([existing]);
    return prisma.role.update({
      where: { id: existing.id, isSystemRole: true, deletedAt: null },
      data: { description: seed.description },
    });
  }
  return prisma.role.create({
    data: {
      name: seed.name,
      description: seed.description,
      isSystemRole: true,
    },
  });
}
