import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { getPermissionCatalogIssues } from '../../src/common/consts/permission-catalog';

const prisma = new PrismaClient();

async function main() {
  const permissions = await prisma.permission.findMany({
    where: { deletedAt: null },
    select: { key: true, isSystemPermission: true },
    orderBy: { key: 'asc' },
  });
  const issues = getPermissionCatalogIssues(permissions);
  if (issues.length > 0) throw new Error(issues.join('\n'));
  console.log(
    `Permission catalog matches code (${permissions.length} permissions). No data changed.`,
  );
}

main()
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
