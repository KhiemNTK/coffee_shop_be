import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { PrismaClient, Prisma } from '@prisma/client';

describe('Stock reservation migration rehearsal (PostgreSQL)', () => {
  const prisma = new PrismaClient();
  const sql = readFileSync(
    resolve(
      __dirname,
      '../prisma/migrations/20261018000000_stock_reservations_customer_orders/migration.sql',
    ),
    'utf8',
  );
  const body = sql.replace(/^BEGIN;\s*/, '').replace(/\s*COMMIT;\s*$/, '');

  beforeAll(() => {
    const target = new URL(process.env.DATABASE_URL ?? '');
    assert(
      process.env.NODE_ENV === 'test' &&
        ['localhost', '127.0.0.1'].includes(target.hostname) &&
        target.pathname.endsWith('_test'),
      'Use only an isolated loopback test DB.',
    );
    assert(sql.startsWith('BEGIN;') && sql.trimEnd().endsWith('COMMIT;'));
  });
  afterAll(() => prisma.$disconnect());

  const rehearse = async (stock: string) => {
    const rollback = new Error('ROLLBACK_REHEARSAL');
    try {
      await prisma.$transaction(
        async (tx) => {
          // Only throwaway schema clones are modified; the outer transaction always rolls back.
          const schema = `migration_fixture_${randomBytes(6).toString('hex')}`;
          await tx.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`);
          for (const table of [
            'Customer',
            'Unit',
            'InventoryCategory',
            'InventoryItem',
            'OrderSession',
            'OnlineOrderRequest',
            'OrderItem',
            'MenuItemIngredient',
            'OrderItemRecipeIngredient',
          ]) {
            await tx.$executeRawUnsafe(
              `CREATE TABLE "${schema}"."${table}" (LIKE public."${table}" INCLUDING ALL)`,
            );
          }
          await tx.$executeRawUnsafe(
            `SET LOCAL search_path TO "${schema}", public`,
          );
          await tx.$executeRawUnsafe(
            'ALTER TABLE "InventoryItem" DROP COLUMN "reservedStock"',
          );
          await tx.$executeRawUnsafe(
            'ALTER TABLE "OnlineOrderRequest" DROP COLUMN "customerId"',
          );
          await tx.$executeRaw`INSERT INTO "Unit" (id, name, "updatedAt") VALUES ('unit', 'kg', NOW())`;
          await tx.$executeRaw`INSERT INTO "InventoryCategory" (id, name, "updatedAt") VALUES ('category', 'Ingredients', NOW())`;
          await tx.$executeRaw`INSERT INTO "InventoryItem" (id, name, "categoryId", "unitId", stock, "updatedAt") VALUES ('stock', 'Milk', 'category', 'unit', ${stock}::numeric, NOW())`;
          await tx.$executeRaw`INSERT INTO "OrderSession" (id, "employeeId", "sessionStatus", "updatedAt") VALUES ('session', 'actor', 'COMPLETED', NOW())`;
          await tx.$executeRaw`INSERT INTO "OnlineOrderRequest" (id, "clientRequestId", "requestHash", "pickupName", "phoneNumber", "quotedSubtotal", status, "orderSessionId", "expiresAt", "reviewedAt", "reviewedById") VALUES ('request', 'client', ${'0'.repeat(64)}, 'Fixture pickup', '0901234567', 30000, 'ACCEPTED', 'session', NOW() + INTERVAL '30 minutes', NOW(), 'actor')`;
          await tx.$executeRaw`INSERT INTO "OrderItem" (id, quantity, "priceAtTime", "orderSessionId", "menuItemId", "recipeSnapshottedAt", "isPaid", "invoiceId", "updatedAt") VALUES ('snapshotted', 2, 30000, 'session', 'menu', NOW(), true, 'invoice', NOW()), ('legacy', 1, 30000, 'session', 'legacy-menu', NULL, true, 'invoice', NOW())`;
          await tx.$executeRaw`INSERT INTO "OrderItemRecipeIngredient" ("orderItemId", "inventoryItemId", "quantityPerItem") VALUES ('snapshotted', 'stock', 0.6)`;
          await tx.$executeRaw`INSERT INTO "MenuItemIngredient" ("menuItemId", "inventoryItemId", quantity) VALUES ('menu', 'stock', 0.9), ('legacy-menu', 'stock', 0.2)`;
          await tx.$executeRawUnsafe(
            `DO $rehearsal$ BEGIN ${body} END $rehearsal$;`,
          );
          const [row] = await tx.$queryRaw<
            Array<{
              stock: Prisma.Decimal;
              reservedStock: Prisma.Decimal;
              held: Prisma.Decimal;
            }>
          >`
          SELECT i.stock, i."reservedStock", (SELECT SUM(quantity) FROM "InventoryReservation") AS held
          FROM "InventoryItem" i WHERE i.id = 'stock'
        `;
          expect(row.stock.toString()).toBe(stock);
          expect(row.reservedStock.toString()).toBe('1.4');
          expect(row.held.toString()).toBe('1.4');
          const [owner] = await tx.$queryRaw<
            Array<{ customerId: string | null }>
          >`SELECT "customerId" FROM "OnlineOrderRequest" WHERE id = 'request'`;
          expect(owner.customerId).toBeNull();
          throw rollback;
        },
        { timeout: 20000 },
      );
    } catch (error) {
      if (error !== rollback) throw error;
    }
  };

  it('preserves physical stock, uses stored recipes and covers paid sessions awaiting preparation', async () => {
    await rehearse('3');
  });
  it('aborts rather than inventing inventory when existing commitments exceed stock', async () => {
    await expect(rehearse('0.1')).rejects.toThrow(
      'Insufficient stock for existing accepted orders',
    );
  });
});
