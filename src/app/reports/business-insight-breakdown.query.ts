import { Prisma } from '@prisma/client';
import type {
  BusinessInsightBreakdownRow,
  BusinessInsightSnapshot,
  ExtendedPrismaTransactionClient,
} from '../../common/types';

export async function queryInsightBreakdown(
  tx: ExtendedPrismaTransactionClient,
  current: { from: Date; to: Date },
  previous: { from: Date; to: Date },
): Promise<BusinessInsightSnapshot['metrics']> {
  const rows = await tx.$queryRaw<BusinessInsightBreakdownRow[]>(Prisma.sql`
    WITH periods AS (
      SELECT * FROM (VALUES
        (${current.from}::timestamp, ${current.to}::timestamp, true),
        (${previous.from}::timestamp, ${previous.to}::timestamp, false)
      ) AS p("from", "to", "current")
    ), lines AS (
      SELECT p."current", mi."id" AS "itemId", mi."name" AS "itemName",
        mc."id" AS "categoryId", mc."name" AS "categoryName", oi."quantity",
        oi."priceAtTime" * oi."quantity" AS "grossSales"
      FROM periods p
      JOIN "Invoice" i ON i."createdAt" >= p."from" AND i."createdAt" < p."to"
        AND i."paymentStatus" IN ('PAID', 'PARTIALLY_REFUNDED', 'REFUNDED')
      JOIN "OrderItem" oi ON oi."invoiceId" = i."id" AND oi."serveStatus" <> 'CANCELLED'
      JOIN "MenuItem" mi ON mi."id" = oi."menuItemId"
      JOIN "MenuCategory" mc ON mc."id" = mi."categoryId"
    ), groups AS (
      SELECT CASE WHEN GROUPING("itemId") = 0 THEN 'item' ELSE 'category' END AS kind,
        COALESCE("itemId", "categoryId") AS id,
        COALESCE("itemName", "categoryName") AS name,
        COALESCE(SUM("quantity") FILTER (WHERE "current"), 0)::bigint AS quantity,
        COALESCE(SUM("quantity") FILTER (WHERE NOT "current"), 0)::bigint AS "previousQuantity",
        COALESCE(SUM("grossSales") FILTER (WHERE "current"), 0)::numeric AS sales,
        COALESCE(SUM("grossSales") FILTER (WHERE NOT "current"), 0)::numeric AS "previousSales"
      FROM lines GROUP BY GROUPING SETS (("itemId", "itemName"), ("categoryId", "categoryName"))
    ), ranked AS (
      SELECT *, ROW_NUMBER() OVER (PARTITION BY kind ORDER BY sales DESC, quantity DESC, id) AS rank
      FROM groups WHERE quantity > 0
    ) SELECT * FROM ranked WHERE rank <= 5 ORDER BY kind, rank
  `);
  return rows.flatMap((row) => {
    const prefix = `${row.kind}.${row.id}`;
    const label = `${row.kind === 'item' ? 'Món' : 'Danh mục'}: ${row.name.slice(0, 120)}`;
    return [
      {
        key: `${prefix}.sales`,
        label: `${label} - Doanh số trước giảm giá`,
        unit: 'VND' as const,
        value: row.sales.toFixed(2),
        previousValue: row.previousSales.toFixed(2),
      },
      {
        key: `${prefix}.quantity`,
        label: `${label} - Số lượng bán`,
        unit: 'COUNT' as const,
        value: row.quantity.toString(),
        previousValue: row.previousQuantity.toString(),
      },
    ];
  });
}
