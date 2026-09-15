import 'dotenv/config';
import { Prisma, PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const checks: Array<{ name: string; query: Prisma.Sql }> = [
  {
    name: 'duplicate active role names',
    query: Prisma.sql`
      SELECT COUNT(*)::bigint AS violations
      FROM (
        SELECT "name"
        FROM "Role"
        WHERE "deletedAt" IS NULL
        GROUP BY "name"
        HAVING COUNT(*) > 1
      ) duplicates
    `,
  },
  {
    name: 'duplicate active permission keys',
    query: Prisma.sql`
      SELECT COUNT(*)::bigint AS violations
      FROM (
        SELECT "key"
        FROM "Permission"
        WHERE "deletedAt" IS NULL
        GROUP BY "key"
        HAVING COUNT(*) > 1
      ) duplicates
    `,
  },
  {
    name: 'invalid role-permission links',
    query: Prisma.sql`
      SELECT COUNT(*)::bigint AS violations
      FROM "RolePermission" rp
      LEFT JOIN "Role" r ON r."id" = rp."roleId"
      LEFT JOIN "Permission" p ON p."id" = rp."permissionId"
      WHERE r."id" IS NULL OR p."id" IS NULL
         OR r."deletedAt" IS NOT NULL OR p."deletedAt" IS NOT NULL
    `,
  },
  {
    name: 'invalid employee-role links',
    query: Prisma.sql`
      SELECT COUNT(*)::bigint AS violations
      FROM "EmployeeRole" er
      LEFT JOIN "Role" r ON r."id" = er."roleId"
      LEFT JOIN "Employee" e ON e."id" = er."employeeId"
      WHERE r."id" IS NULL OR e."id" IS NULL
         OR r."deletedAt" IS NOT NULL OR e."deletedAt" IS NOT NULL
    `,
  },
  {
    name: 'duplicate active inventory category names',
    query: Prisma.sql`
      SELECT COUNT(*)::bigint AS violations
      FROM (
        SELECT LOWER("name")
        FROM "InventoryCategory"
        WHERE "deletedAt" IS NULL
        GROUP BY LOWER("name")
        HAVING COUNT(*) > 1
      ) duplicates
    `,
  },
  {
    name: 'duplicate active unit names',
    query: Prisma.sql`
      SELECT COUNT(*)::bigint AS violations
      FROM (
        SELECT LOWER("name")
        FROM "Unit"
        WHERE "deletedAt" IS NULL
        GROUP BY LOWER("name")
        HAVING COUNT(*) > 1
      ) duplicates
    `,
  },
  {
    name: 'duplicate active inventory item names per category',
    query: Prisma.sql`
      SELECT COUNT(*)::bigint AS violations
      FROM (
        SELECT "categoryId", LOWER("name")
        FROM "InventoryItem"
        WHERE "deletedAt" IS NULL
        GROUP BY "categoryId", LOWER("name")
        HAVING COUNT(*) > 1
      ) duplicates
    `,
  },
  {
    name: 'negative inventory stock',
    query: Prisma.sql`
      SELECT COUNT(*)::bigint AS violations
      FROM "InventoryItem"
      WHERE "stock" < 0
    `,
  },
  {
    name: 'non-positive inventory transaction quantity',
    query: Prisma.sql`
      SELECT COUNT(*)::bigint AS violations
      FROM "InventoryTransaction"
      WHERE "quantity" <= 0
    `,
  },
  {
    name: 'negative inventory transaction unit price',
    query: Prisma.sql`
      SELECT COUNT(*)::bigint AS violations
      FROM "InventoryTransaction"
      WHERE "unitPrice" < 0
    `,
  },
  {
    name: 'negative inventory transaction total amount',
    query: Prisma.sql`
      SELECT COUNT(*)::bigint AS violations
      FROM "InventoryTransaction"
      WHERE "totalAmount" < 0
    `,
  },
  {
    name: 'duplicate active promotion names',
    query: Prisma.sql`
      SELECT COUNT(*)::bigint AS violations
      FROM (
        SELECT LOWER("name")
        FROM "Promotion"
        WHERE "deletedAt" IS NULL
        GROUP BY LOWER("name")
        HAVING COUNT(*) > 1
      ) duplicates
    `,
  },
  {
    name: 'invalid promotion date ranges',
    query: Prisma.sql`
      SELECT COUNT(*)::bigint AS violations
      FROM "Promotion"
      WHERE "startDate" >= "endDate"
    `,
  },
  {
    name: 'non-positive promotion discount values',
    query: Prisma.sql`
      SELECT COUNT(*)::bigint AS violations
      FROM "Promotion"
      WHERE "discountValue" <= 0
    `,
  },
  {
    name: 'non-positive promotion maximum discounts',
    query: Prisma.sql`
      SELECT COUNT(*)::bigint AS violations
      FROM "Promotion"
      WHERE "maxDiscount" IS NOT NULL AND "maxDiscount" <= 0
    `,
  },
  {
    name: 'promotion percentage values above 100',
    query: Prisma.sql`
      SELECT COUNT(*)::bigint AS violations
      FROM "Promotion"
      WHERE "discountType" = 'PERCENTAGE' AND "discountValue" > 100
    `,
  },
];

async function main() {
  const failures: Array<{ name: string; violations: number }> = [];

  for (const check of checks) {
    const [result] = await prisma.$queryRaw<Array<{ violations: bigint }>>(
      check.query,
    );
    const violations = Number(result?.violations ?? 0);
    console.log(`${violations === 0 ? 'PASS' : 'FAIL'} ${check.name}`);
    if (violations > 0) failures.push({ name: check.name, violations });
  }

  if (failures.length > 0) {
    throw new Error(
      `Migration preflight failed: ${failures
        .map(({ name, violations }) => `${name} (${violations})`)
        .join(', ')}`,
    );
  }
}

main()
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
