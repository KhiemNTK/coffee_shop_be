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
    name: 'duplicate active position names',
    query: Prisma.sql`
      SELECT COUNT(*)::bigint AS violations
      FROM (
        SELECT LOWER(BTRIM("name"))
        FROM "Position"
        WHERE "deletedAt" IS NULL
        GROUP BY LOWER(BTRIM("name"))
        HAVING COUNT(*) > 1
      ) duplicates
    `,
  },
  {
    name: 'duplicate active dining table names',
    query: Prisma.sql`
      SELECT COUNT(*)::bigint AS violations
      FROM (
        SELECT LOWER(BTRIM("name"))
        FROM "DiningTable"
        WHERE "deletedAt" IS NULL
        GROUP BY LOWER(BTRIM("name"))
        HAVING COUNT(*) > 1
      ) duplicates
    `,
  },
  {
    name: 'duplicate active fund names',
    query: Prisma.sql`
      SELECT COUNT(*)::bigint AS violations
      FROM (
        SELECT LOWER(BTRIM("name"))
        FROM "Fund"
        WHERE "deletedAt" IS NULL
        GROUP BY LOWER(BTRIM("name"))
        HAVING COUNT(*) > 1
      ) duplicates
    `,
  },
  {
    name: 'duplicate active menu category names',
    query: Prisma.sql`
      SELECT COUNT(*)::bigint AS violations
      FROM (
        SELECT LOWER(BTRIM("name"))
        FROM "MenuCategory"
        WHERE "deletedAt" IS NULL
        GROUP BY LOWER(BTRIM("name"))
        HAVING COUNT(*) > 1
      ) duplicates
    `,
  },
  {
    name: 'duplicate active menu item names per category',
    query: Prisma.sql`
      SELECT COUNT(*)::bigint AS violations
      FROM (
        SELECT "categoryId", LOWER(BTRIM("name"))
        FROM "MenuItem"
        WHERE "deletedAt" IS NULL
        GROUP BY "categoryId", LOWER(BTRIM("name"))
        HAVING COUNT(*) > 1
      ) duplicates
    `,
  },
  {
    name: 'multiple active order sessions per table',
    query: Prisma.sql`
      SELECT COUNT(*)::bigint AS violations
      FROM (
        SELECT "tableId"
        FROM "OrderSession"
        WHERE "tableId" IS NOT NULL AND "sessionStatus" = 'ACTIVE'
        GROUP BY "tableId"
        HAVING COUNT(*) > 1
      ) duplicates
    `,
  },
  {
    name: 'dining table and active session status mismatches',
    query: Prisma.sql`
      SELECT COUNT(*)::bigint AS violations
      FROM (
        SELECT dt."id", dt."status", COUNT(os."id") AS active_sessions
        FROM "DiningTable" dt
        LEFT JOIN "OrderSession" os
          ON os."tableId" = dt."id" AND os."sessionStatus" = 'ACTIVE'
        WHERE dt."deletedAt" IS NULL
        GROUP BY dt."id", dt."status"
        HAVING (COUNT(os."id") > 0 AND dt."status" <> 'OCCUPIED')
          OR (COUNT(os."id") = 0 AND dt."status" = 'OCCUPIED')
      ) mismatches
    `,
  },
  {
    name: 'multiple open cashier shifts per employee',
    query: Prisma.sql`
      SELECT COUNT(*)::bigint AS violations
      FROM (
        SELECT "employeeId"
        FROM "CashierShift"
        WHERE "status" = 'OPEN'
        GROUP BY "employeeId"
        HAVING COUNT(*) > 1
      ) duplicates
    `,
  },
  {
    name: 'inconsistent cashier shift states',
    query: Prisma.sql`
      SELECT COUNT(*)::bigint AS violations
      FROM "CashierShift"
      WHERE NOT (
        ("status" = 'OPEN'
          AND "closedAt" IS NULL
          AND "reportedEndingCash" IS NULL
          AND "actualEndingCash" IS NULL)
        OR
        ("status" = 'CLOSED'
          AND "closedAt" IS NOT NULL
          AND "reportedEndingCash" IS NOT NULL
          AND "actualEndingCash" IS NOT NULL
          AND "closedAt" >= "openedAt")
      )
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
  {
    name: 'money values incompatible with decimal 18,2',
    query: Prisma.sql`
      SELECT COUNT(*)::bigint AS violations
      FROM (
        SELECT "salary" AS value FROM "Position"
        UNION ALL SELECT "balance" FROM "Fund"
        UNION ALL SELECT "price" FROM "MenuItem"
        UNION ALL SELECT "discountValue" FROM "Promotion"
        UNION ALL SELECT "maxDiscount" FROM "Promotion"
        UNION ALL SELECT "unitPrice" FROM "Equipment"
        UNION ALL SELECT "totalAmount" FROM "Equipment"
        UNION ALL SELECT "salary" FROM "Employee"
        UNION ALL SELECT "startingCash" FROM "CashierShift"
        UNION ALL SELECT "reportedEndingCash" FROM "CashierShift"
        UNION ALL SELECT "actualEndingCash" FROM "CashierShift"
        UNION ALL SELECT "unitPrice" FROM "InventoryTransaction"
        UNION ALL SELECT "totalAmount" FROM "InventoryTransaction"
        UNION ALL SELECT "priceAtTime" FROM "OrderItem"
        UNION ALL SELECT "subTotal" FROM "Invoice"
        UNION ALL SELECT "discountAmount" FROM "Invoice"
        UNION ALL SELECT "totalAmount" FROM "Invoice"
        UNION ALL SELECT "amountTendered" FROM "Invoice"
        UNION ALL SELECT "changeAmount" FROM "Invoice"
        UNION ALL SELECT "taxAmount" FROM "Invoice"
        UNION ALL SELECT "amount" FROM "CashTransaction"
      ) values_to_check
      WHERE value IS NOT NULL
        AND (ABS(value) >= 10000000000000000 OR value <> ROUND(value, 2))
    `,
  },
  {
    name: 'quantity values incompatible with decimal 18,4',
    query: Prisma.sql`
      SELECT COUNT(*)::bigint AS violations
      FROM (
        SELECT "stock" AS value FROM "InventoryItem"
        UNION ALL SELECT "quantity" FROM "MenuItemIngredient"
        UNION ALL SELECT "quantity" FROM "InventoryTransaction"
      ) values_to_check
      WHERE ABS(value) >= 100000000000000
         OR value <> ROUND(value, 4)
    `,
  },
  {
    name: 'invoice tax rates incompatible with decimal 5,2',
    query: Prisma.sql`
      SELECT COUNT(*)::bigint AS violations
      FROM "Invoice"
      WHERE ABS("taxRate") >= 1000 OR "taxRate" <> ROUND("taxRate", 2)
    `,
  },
  {
    name: 'invalid single-store monetary and quantity values',
    query: Prisma.sql`
      SELECT COUNT(*)::bigint AS violations
      FROM (
        SELECT 1 FROM "Position" WHERE "salary" < 0
        UNION ALL SELECT 1 FROM "MenuItem" WHERE "price" < 0
        UNION ALL SELECT 1 FROM "Equipment"
          WHERE "quantity" <= 0 OR "unitPrice" < 0 OR "totalAmount" < 0
        UNION ALL SELECT 1 FROM "Employee" WHERE "salary" < 0
        UNION ALL SELECT 1 FROM "CashierShift"
          WHERE "startingCash" < 0
             OR "reportedEndingCash" < 0
             OR "actualEndingCash" < 0
        UNION ALL SELECT 1 FROM "MenuItemIngredient" WHERE "quantity" <= 0
        UNION ALL SELECT 1 FROM "OrderItem"
          WHERE "quantity" <= 0 OR "priceAtTime" < 0
        UNION ALL SELECT 1 FROM "Invoice"
          WHERE "subTotal" < 0
             OR "discountAmount" < 0
             OR "discountAmount" > "subTotal"
             OR "totalAmount" < 0
             OR "amountTendered" < 0
             OR "changeAmount" < 0
             OR "taxAmount" < 0
             OR "taxRate" < 0
             OR "taxRate" > 100
        UNION ALL SELECT 1 FROM "CashTransaction" WHERE "amount" <= 0
      ) invalid_values
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
