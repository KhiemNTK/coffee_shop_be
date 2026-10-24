import { createHash } from 'node:crypto';
import { Prisma, type PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { buildCatalogData } from './catalog-data';
import {
  calculateInventoryValue,
  calculateWeightedAverageCost,
} from '../src/app/inventory/services/inventory-costing';

const DAY = 86_400_000;
const SOURCE = 'coffee-homes-local-activity-v1';
const CUSTOMER_COUNT = 50;
const ORDER_COUNT = 300;
const DAYS = 30;
const money = (value: Prisma.Decimal.Value = 0) => new Prisma.Decimal(value);
const id = (key: string) => {
  const bytes = createHash('sha256').update(`${SOURCE}:${key}`).digest();
  bytes[6] = (bytes[6] & 15) | 64;
  bytes[8] = (bytes[8] & 63) | 128;
  const hex = bytes.subarray(0, 16).toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};

export const ActivityOptionsSchema = z.object({
  seed: z.number().int().min(0).max(0xffffffff),
  through: z.iso.date(),
});
type ActivityOptions = z.infer<typeof ActivityOptionsSchema>;

const menuSelect = {
  id: true,
  name: true,
  price: true,
  isAvailable: true,
  kitchenStationId: true,
  kitchenStation: { select: { prepSlaSeconds: true } },
  ingredients: {
    orderBy: { inventoryItemId: 'asc' },
    select: {
      quantity: true,
      inventoryItem: {
        select: {
          id: true,
          name: true,
          unitId: true,
          stock: true,
          reservedStock: true,
          averageUnitCost: true,
          reorderPoint: true,
          deletedAt: true,
          unit: { select: { name: true, deletedAt: true } },
          category: { select: { deletedAt: true } },
        },
      },
    },
  },
} as const satisfies Prisma.MenuItemSelect;
type ActivityMenu = Prisma.MenuItemGetPayload<{ select: typeof menuSelect }>;

export function buildActivityPlan(
  input: ActivityOptions,
  menus: ActivityMenu[],
  tables: { id: string; name: string }[],
  positionId: string,
) {
  const options = ActivityOptionsSchema.parse(input);
  const end = new Date(`${options.through}T00:00:00+07:00`).getTime() + DAY;
  if (end > Date.now())
    throw new Error('Only completed Vietnam business days are allowed.');
  if (menus.length < 2 || tables.length === 0)
    throw new Error(
      'Seed the catalog with recipes, active stations and tables first.',
    );
  const start = end - DAYS * DAY;
  const catalog = buildCatalogData(options.seed);
  const costs = catalog.referenceUnitCosts;
  const stock = new Map<
    string,
    ActivityMenu['ingredients'][number]['inventoryItem']
  >(
    menus.flatMap((menu) =>
      menu.ingredients.map(
        ({ inventoryItem }) =>
          [
            inventoryItem.id,
            {
              ...inventoryItem,
              stock: money(inventoryItem.stock),
              averageUnitCost: money(inventoryItem.averageUnitCost),
            },
          ] as const,
      ),
    ),
  );
  for (const item of stock.values()) {
    if (
      item.deletedAt ||
      item.unit.deletedAt ||
      item.category.deletedAt ||
      !item.reservedStock.isZero() ||
      !costs.has(item.id)
    )
      throw new Error(
        'Activity seed requires active catalog ingredients without outstanding holds.',
      );
  }
  let state = options.seed;
  const random = (min: number, max: number) => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return min + (state % (max - min + 1));
  };
  const date = (time: number) => new Date(time);
  const actorId = id('cashier');
  const actorName = 'Nguyen Minh Anh';
  const fundId = id('fund');
  const supplierId = id('supplier');
  const data = {
    customers: [] as Prisma.CustomerCreateManyInput[],
    wishlists: [] as Prisma.CustomerWishlistCreateManyInput[],
    shifts: [] as Prisma.CashierShiftCreateManyInput[],
    sessions: [] as Prisma.OrderSessionCreateManyInput[],
    requests: [] as Prisma.OnlineOrderRequestCreateManyInput[],
    requestItems: [] as Prisma.OnlineOrderRequestItemCreateManyInput[],
    items: [] as Prisma.OrderItemCreateManyInput[],
    recipes: [] as Prisma.OrderItemRecipeIngredientCreateManyInput[],
    snapshots: [] as Prisma.OrderItemIngredientSnapshotCreateManyInput[],
    waste: [] as Prisma.InventoryWasteCreateManyInput[],
    tickets: [] as Prisma.KitchenTicketCreateManyInput[],
    ticketItems: [] as Prisma.KitchenTicketItemCreateManyInput[],
    invoices: [] as (Prisma.InvoiceCreateManyInput & {
      totalAmount: Prisma.Decimal;
    })[],
    movements: [] as Prisma.CashTransactionCreateManyInput[],
    refunds: [] as (Prisma.CashRefundCreateManyInput & {
      amount: Prisma.Decimal;
    })[],
    feedback: [] as Prisma.TakeawayFeedbackCreateManyInput[],
    receipts: [] as Prisma.PurchaseReceiptCreateManyInput[],
    receiptItems: [] as Prisma.PurchaseReceiptItemCreateManyInput[],
    inventoryTransactions: [] as Prisma.InventoryTransactionCreateManyInput[],
    audit: [] as Prisma.ActionLogCreateManyInput[],
  };
  const audit = (
    key: string,
    actionType: string,
    time: number,
    details: Prisma.InputJsonObject,
  ) => {
    data.audit.push({
      id: id(`audit:${key}`),
      employeeId: actorId,
      actionType,
      createdAt: date(time),
      requestId: SOURCE,
      details: { source: SOURCE, ...details },
    });
  };
  const names = [
    'Minh Anh',
    'Thanh Ha',
    'Quoc Bao',
    'Bao Ngoc',
    'Hoang Nam',
    'Gia Han',
    'Duc Minh',
    'Thao Linh',
    'Hai Dang',
    'Kim Ngan',
  ];
  for (let i = 0; i < CUSTOMER_COUNT; i++) {
    const customerId = id(`customer:${i}`);
    const joined = date(start - random(1, 60) * DAY);
    data.customers.push({
      id: customerId,
      googleSubject: `${SOURCE}:${i}`,
      email: `customer.${i + 1}@coffee-homes.example.test`,
      createdAt: joined,
      updatedAt: joined,
    });
    const favorites = new Set<string>();
    const target = Math.min(menus.length, random(2, 6));
    while (favorites.size < target)
      favorites.add(menus[random(0, menus.length - 1)].id);
    for (const menuItemId of favorites)
      data.wishlists.push({ customerId, menuItemId, createdAt: joined });
  }

  const counts = Array<number>(DAYS).fill(6);
  for (let i = DAYS * 6; i < ORDER_COUNT; i++) counts[random(0, DAYS - 1)]++;
  const drinks = menus.filter(
    (m) => m.kitchenStationId === catalog.stations[0].id,
  );
  const pastry = menus.filter(
    (m) => m.kitchenStationId === catalog.stations[1].id,
  );
  const popular = drinks.length
    ? drinks.slice(0, Math.min(6, drinks.length))
    : menus;
  const hours = [7, 8, 8, 9, 10, 11, 12, 12, 13, 14, 15, 16, 17, 18, 19, 20];
  const orders = counts
    .flatMap((count, day) =>
      Array.from({ length: count }, () => {
        const online = random(0, 99) < 45;
        const outcomeRoll = random(0, 99);
        const outcome =
          outcomeRoll < 4 && online
            ? 'REJECTED'
            : outcomeRoll < 9
              ? 'CANCELLED_PENDING'
              : outcomeRoll < 13
                ? 'CANCELLED_PREPARED'
                : 'SERVED';
        const pool = random(0, 99) < 70 ? popular : menus;
        const picks = new Map<string, ActivityMenu>();
        const first = pool[random(0, pool.length - 1)];
        picks.set(first.id, first);
        if (pastry.length && random(0, 99) < 55) {
          const extra = pastry[random(0, pastry.length - 1)];
          picks.set(extra.id, extra);
        }
        if (random(0, 99) < 25) {
          const extra = menus[random(0, menus.length - 1)];
          picks.set(extra.id, extra);
        }
        return {
          day,
          online,
          outcome,
          customer: random(0, CUSTOMER_COUNT - 1),
          createdAt:
            start +
            day * DAY +
            (hours[random(0, hours.length - 1)] * 60 + random(0, 59)) * 60_000,
          lines: [...picks.values()].map((menu) => ({
            menu,
            quantity: random(0, 99) < 25 ? random(2, 3) : 1,
          })),
        };
      }),
    )
    .sort((a, b) => a.createdAt - b.createdAt);

  let balance = money(500000);
  data.movements.push({
    id: id('opening-float'),
    fundId,
    employeeId: actorId,
    type: 'INCOME',
    amount: balance,
    description: `${SOURCE}: synthetic opening float`,
    transactionDate: date(start + 6 * 3_600_000),
    createdAt: date(start + 6 * 3_600_000),
  });
  for (let day = 0; day < DAYS; day++) {
    const dayStart = start + day * DAY;
    if (day % 7 === 0) {
      const week = day / 7;
      const receiptId = id(`receipt:${week}`);
      let total = money();
      for (const ingredient of stock.values()) {
        const required = orders
          .filter(
            (o) =>
              o.day >= day &&
              o.day < day + 7 &&
              ['SERVED', 'CANCELLED_PREPARED'].includes(o.outcome),
          )
          .reduce(
            (sum, order) =>
              order.lines.reduce(
                (subtotal, line) =>
                  subtotal.add(
                    line.menu.ingredients
                      .filter((r) => r.inventoryItem.id === ingredient.id)
                      .reduce(
                        (value, r) => value.add(r.quantity.mul(line.quantity)),
                        money(),
                      ),
                  ),
                sum,
              ),
            money(),
          );
        let quantity = required
          .mul('1.15')
          .add(ingredient.reorderPoint)
          .sub(ingredient.stock)
          .toDecimalPlaces(4);
        if (ingredient.unitId === catalog.units[2].id)
          quantity = quantity.ceil();
        if (quantity.lte(0)) continue;
        const unitPrice = costs
          .get(ingredient.id)!
          .mul(100 + random(-5, 5))
          .div(100)
          .toDecimalPlaces(2);
        const amount = calculateInventoryValue(quantity, unitPrice);
        ingredient.averageUnitCost = calculateWeightedAverageCost({
          stock: ingredient.stock,
          averageUnitCost: ingredient.averageUnitCost,
          importedQuantity: quantity,
          importedUnitCost: unitPrice,
        });
        ingredient.stock = ingredient.stock.add(quantity);
        const receiptItemId = id(`receipt:${week}:${ingredient.id}`);
        data.receiptItems.push({
          id: receiptItemId,
          purchaseReceiptId: receiptId,
          inventoryItemId: ingredient.id,
          inventoryItemName: ingredient.name,
          unitName: ingredient.unit.name,
          quantity,
          unitPrice,
          totalAmount: amount,
          createdAt: date(dayStart + 6.5 * 3_600_000),
        });
        data.inventoryTransactions.push({
          id: id(`import:${week}:${ingredient.id}`),
          type: 'IMPORT',
          inventoryItemId: ingredient.id,
          purchaseReceiptItemId: receiptItemId,
          quantity,
          unitPrice,
          totalAmount: amount,
          note: SOURCE,
          transactionDate: date(dayStart + 6.5 * 3_600_000),
          createdAt: date(dayStart + 6.5 * 3_600_000),
        });
        total = total.add(amount);
      }
      if (total.gt(0)) {
        data.receipts.push({
          id: receiptId,
          receiptNumber: `PR-CH-L01-${week + 1}`,
          supplierId,
          createdById: actorId,
          postedById: actorId,
          status: 'POSTED',
          note: SOURCE,
          totalAmount: total,
          receivedAt: date(dayStart + 6.5 * 3_600_000),
          postedAt: date(dayStart + 6.5 * 3_600_000),
          createdAt: date(dayStart + 6.4 * 3_600_000),
        });
        audit(
          `receipt:${week}`,
          'INVENTORY_PURCHASE_RECEIPT_POSTED',
          dayStart + 6.5 * 3_600_000,
          { purchaseReceiptId: receiptId, totalAmount: total.toFixed(2) },
        );
      }
    }
    const shiftId = id(`shift:${day}`);
    const opening = balance;
    const occupiedUntil = new Map<string, number>();
    for (const [index, order] of orders.entries()) {
      if (order.day !== day) continue;
      const sessionId = id(`session:${index}`);
      const invoiceId = id(`invoice:${index}`);
      const requestId = id(`request:${index}`);
      const served = order.outcome === 'SERVED';
      const prepared = served || order.outcome === 'CANCELLED_PREPARED';
      const table = order.online ? null : tables[index % tables.length];
      const tableId = table?.id ?? null;
      const createdAt = Math.max(
        order.createdAt,
        tableId ? (occupiedUntil.get(tableId) ?? 0) : 0,
      );
      const reviewedAt = createdAt + (order.online ? random(1, 3) : 0) * 60_000;
      const readyAt = reviewedAt + random(3, 22) * 60_000;
      const finishedAt =
        readyAt + (order.online ? random(1, 8) : random(10, 30)) * 60_000;
      if (tableId) occupiedUntil.set(tableId, finishedAt + 60_000);
      const subtotal = order.lines.reduce(
        (sum, line) => sum.add(line.menu.price.mul(line.quantity)),
        money(),
      );
      if (order.online) {
        data.requests.push({
          id: requestId,
          clientRequestId: id(`client:${index}`),
          requestHash: createHash('sha256')
            .update(`${SOURCE}:${index}`)
            .digest('hex'),
          pickupName: names[order.customer % names.length],
          phoneNumber: '0900000000',
          customerId: data.customers[order.customer].id,
          quotedSubtotal: subtotal,
          status:
            order.outcome === 'REJECTED'
              ? 'REJECTED'
              : served
                ? 'ACCEPTED'
                : 'CANCELLED',
          orderSessionId: order.outcome === 'REJECTED' ? null : sessionId,
          createdAt: date(createdAt),
          expiresAt: date(createdAt + 15 * 60_000),
          reviewedAt: date(reviewedAt),
          reviewedById: actorId,
          rejectionReason:
            order.outcome === 'REJECTED'
              ? 'Capacity reached; synthetic history.'
              : null,
          cancellationReason:
            !served && order.outcome !== 'REJECTED'
              ? 'Customer cancelled; synthetic history.'
              : null,
          cancelledAt:
            !served && order.outcome !== 'REJECTED' ? date(finishedAt) : null,
        });
        order.lines.forEach((line, lineNumber) =>
          data.requestItems.push({
            id: id(`request-line:${index}:${lineNumber}`),
            onlineOrderRequestId: requestId,
            lineNumber: lineNumber + 1,
            menuItemId: line.menu.id,
            quantity: line.quantity,
            quotedName: line.menu.name,
            quotedUnitPrice: line.menu.price,
          }),
        );
      }
      if (order.outcome === 'REJECTED') continue;
      data.sessions.push({
        id: sessionId,
        employeeId: actorId,
        shiftId,
        tableId,
        sessionStatus: served ? 'COMPLETED' : 'CANCELLED',
        guestCount: order.online ? null : random(1, 4),
        createdAt: date(reviewedAt),
        updatedAt: date(finishedAt),
      });
      const tickets = new Map<string, string>();
      order.lines.forEach((line, lineNumber) => {
        const itemId = id(`item:${index}:${lineNumber}`);
        data.items.push({
          id: itemId,
          orderSessionId: sessionId,
          menuItemId: line.menu.id,
          quantity: line.quantity,
          priceAtTime: line.menu.price,
          serveStatus: served ? 'SERVED' : 'CANCELLED',
          isPaid: served,
          invoiceId: served ? invoiceId : null,
          recipeSnapshottedAt: date(reviewedAt),
          readyAt: prepared ? date(readyAt) : null,
          createdAt: date(reviewedAt),
          updatedAt: date(finishedAt),
        });
        const stationId = line.menu.kitchenStationId!;
        let ticketId = tickets.get(stationId);
        if (!ticketId) {
          ticketId = id(`ticket:${index}:${stationId}`);
          tickets.set(stationId, ticketId);
          data.tickets.push({
            id: ticketId,
            stationId,
            orderSessionId: sessionId,
            createdAt: date(reviewedAt),
            availableAt: date(reviewedAt),
            dueAt: date(
              reviewedAt + line.menu.kitchenStation!.prepSlaSeconds * 1000,
            ),
          });
        }
        data.ticketItems.push({
          id: id(`ticket-item:${index}:${lineNumber}`),
          ticketId,
          orderItemId: itemId,
          itemName: line.menu.name,
          quantity: line.quantity,
          createdAt: date(reviewedAt),
        });
        for (const recipe of line.menu.ingredients) {
          const ingredient = stock.get(recipe.inventoryItem.id)!;
          data.recipes.push({
            orderItemId: itemId,
            inventoryItemId: ingredient.id,
            quantityPerItem: recipe.quantity,
          });
          if (!prepared) continue;
          const quantity = recipe.quantity.mul(line.quantity);
          ingredient.stock = ingredient.stock.sub(quantity);
          if (ingredient.stock.lt(ingredient.reservedStock))
            throw new Error('Simulated inventory would oversell.');
          const totalCost = calculateInventoryValue(
            quantity,
            ingredient.averageUnitCost,
          );
          data.snapshots.push({
            orderItemId: itemId,
            inventoryItemId: ingredient.id,
            inventoryItemName: ingredient.name,
            unitName: ingredient.unit.name,
            quantityPerItem: recipe.quantity,
            totalQuantity: quantity,
            unitCost: ingredient.averageUnitCost,
            totalCost,
            createdAt: date(reviewedAt + 60_000),
          });
          data.inventoryTransactions.push({
            id: id(`consume:${itemId}:${ingredient.id}`),
            type: 'EXPORT',
            inventoryItemId: ingredient.id,
            orderItemId: itemId,
            quantity,
            unitPrice: ingredient.averageUnitCost,
            totalAmount: totalCost,
            note: SOURCE,
            transactionDate: date(reviewedAt + 60_000),
            createdAt: date(reviewedAt + 60_000),
          });
          if (!served)
            data.waste.push({
              id: id(`waste:${itemId}:${ingredient.id}`),
              orderItemId: itemId,
              inventoryItemId: ingredient.id,
              quantity,
              employeeId: actorId,
              reason: 'Prepared order cancelled; synthetic history.',
              createdAt: date(finishedAt),
            });
        }
      });
      if (!served) {
        audit(`cancel:${index}`, 'ORDER_SESSION_CANCELLED', finishedAt, {
          orderSessionId: sessionId,
        });
        continue;
      }
      // Online COD invoices must match the originally quoted basket exactly.
      const total = subtotal;
      const tendered = total.div(50000).ceil().mul(50000);
      const refund =
        random(0, 99) < 5
          ? random(0, 1)
            ? total
            : total.div(2).toDecimalPlaces(2)
          : money();
      data.invoices.push({
        id: invoiceId,
        documentSnapshot: {
          version: 1,
          source: 'ISSUED',
          tableId,
          tableName: table?.name ?? null,
          issuedByName: actorName,
          promotionName: null,
          items: order.lines.map((line, lineNumber) => ({
            orderItemId: id(`item:${index}:${lineNumber}`),
            menuItemId: line.menu.id,
            name: line.menu.name,
            quantity: line.quantity,
            unitPrice: line.menu.price.toFixed(2),
            note: null,
            selectedOptions: [],
          })),
        },
        invoiceNumber: `CH-${options.through.replaceAll('-', '')}-${String(index + 1).padStart(4, '0')}`,
        employeeId: actorId,
        shiftId,
        orderSessionId: sessionId,
        subTotal: subtotal,
        totalAmount: total,
        amountTendered: tendered,
        changeAmount: tendered.sub(total),
        paymentMethod: 'CASH',
        paymentStatus: refund.eq(total)
          ? 'REFUNDED'
          : refund.gt(0)
            ? 'PARTIALLY_REFUNDED'
            : 'PAID',
        createdAt: date(finishedAt),
        updatedAt: date(finishedAt + (refund.gt(0) ? 5 * 60_000 : 0)),
      });
      data.movements.push({
        id: id(`sale:${index}`),
        invoiceId,
        employeeId: actorId,
        fundId,
        shiftId,
        type: 'INCOME',
        amount: total,
        description: `${SOURCE}: cash sale`,
        transactionDate: date(finishedAt),
        createdAt: date(finishedAt),
      });
      balance = balance.add(total).sub(refund);
      if (refund.gt(0)) {
        const cashTransactionId = id(`refund-cash:${index}`);
        data.movements.push({
          id: cashTransactionId,
          employeeId: actorId,
          fundId,
          shiftId,
          type: 'EXPENSE',
          amount: refund,
          description: `${SOURCE}: cash refund`,
          transactionDate: date(finishedAt + 5 * 60_000),
          createdAt: date(finishedAt + 5 * 60_000),
        });
        data.refunds.push({
          id: id(`refund:${index}`),
          invoiceId,
          requestedById: actorId,
          cashTransactionId,
          amount: refund,
          reason: 'Customer requested compensation; synthetic history.',
          idempotencyKey: `${SOURCE}:${index}`,
          requestHash: createHash('sha256')
            .update(`refund:${SOURCE}:${index}`)
            .digest('hex'),
          completedAt: date(finishedAt + 5 * 60_000),
        });
        audit(
          `refund:${index}`,
          'CASH_REFUND_SUCCEEDED',
          finishedAt + 5 * 60_000,
          { invoiceId, amount: refund.toFixed(2) },
        );
      }
      if (order.online && random(0, 99) < 35 && refund.isZero()) {
        const rating = random(0, 99) < 80 ? random(4, 5) : random(1, 3);
        data.feedback.push({
          id: id(`feedback:${index}`),
          invoiceId,
          rating,
          comment:
            rating >= 4
              ? 'Drinks were ready and packed carefully.'
              : 'Preparation took longer than expected.',
          createdAt: date(finishedAt + 10 * 60_000),
        });
      }
      audit(`invoice:${index}`, 'INVOICE_PAID', finishedAt, {
        invoiceId,
        totalAmount: total.toFixed(2),
      });
    }
    const latest = data.movements
      .filter((row) => row.shiftId === shiftId)
      .reduce(
        (last, row) => Math.max(last, (row.transactionDate as Date).getTime()),
        dayStart,
      );
    data.shifts.push({
      id: shiftId,
      employeeId: actorId,
      fundId,
      status: 'CLOSED',
      openedAt: date(dayStart + 7 * 3_600_000),
      closedAt: date(Math.max(dayStart + 22.5 * 3_600_000, latest + 60_000)),
      startingCash: opening,
      expectedStartingCash: opening,
      openingDifference: money(),
      actualEndingCash: balance,
      reportedEndingCash: balance,
      closingNote: SOURCE,
    });
  }
  const sales = data.invoices.reduce(
    (sum, row) => sum.add(row.totalAmount),
    money(),
  );
  const refunded = data.refunds.reduce(
    (sum, row) => sum.add(row.amount),
    money(),
  );
  const summary = {
    source: SOURCE,
    ...options,
    days: DAYS,
    orders: orders.length,
    customers: data.customers.length,
    invoices: data.invoices.length,
    onlineRequests: data.requests.length,
    refunds: data.refunds.length,
    cancelledSessions: data.sessions.filter(
      (r) => r.sessionStatus === 'CANCELLED',
    ).length,
    purchaseReceipts: data.receipts.length,
    wasteRows: data.waste.length,
    feedback: data.feedback.length,
    cashSales: sales.toFixed(2),
    cashRefunds: refunded.toFixed(2),
    netReceipts: sales.sub(refunded).toFixed(2),
  };
  return {
    data,
    summary,
    start: date(start),
    end: date(end),
    stock,
    actorId,
    fundId,
    supplierId,
    employee: {
      id: actorId,
      positionId,
      fullName: actorName,
      username: 'local.activity.cashier',
      email: 'cashier@coffee-homes.example.test',
      password: '!disabled-local-synthetic-account',
      isActive: false,
      createdAt: date(start - DAY),
    },
    balance,
  };
}

export async function seedActivity(
  prisma: PrismaClient,
  input: ActivityOptions,
  apply = false,
) {
  const options = ActivityOptionsSchema.parse(input);
  const requestHash = createHash('sha256')
    .update(JSON.stringify(options))
    .digest('hex');
  return prisma.$transaction(
    async (tx) => {
      if (apply) {
        const [lock] = await tx.$queryRaw<Array<{ locked: boolean }>>`
          SELECT pg_try_advisory_xact_lock(182746, 22) AS locked
        `;
        if (!lock?.locked)
          throw new Error(
            'Another activity import is running. Retry after it finishes.',
          );
      }
      const existing = await tx.actionLog.findUnique({
        where: { id: id('completed') },
      });
      if (existing) {
        const details = existing.details as {
          requestHash?: string;
          summary?: Prisma.JsonValue;
        };
        if (details.requestHash !== requestHash)
          throw new Error(
            'Activity batch already exists with different parameters. No data changed.',
          );
        return {
          applied: false,
          alreadyApplied: true,
          summary: details.summary,
        };
      }
      const catalog = buildCatalogData(options.seed);
      if (apply)
        await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "InventoryItem"
      WHERE "id" IN (${Prisma.join(catalog.inventoryItems.map((row) => row.id))}) ORDER BY "id" FOR UPDATE`);
      const menus = await tx.menuItem.findMany({
        where: {
          id: { in: catalog.menuItems.map((row) => row.id) },
          deletedAt: null,
          price: { gt: 0 },
          category: { deletedAt: null },
          kitchenStation: { isActive: true, deletedAt: null },
          ingredients: { some: {} },
          optionGroups: { none: {} },
        },
        select: menuSelect,
        orderBy: { id: 'asc' },
      });
      const tables = await tx.diningTable.findMany({
        where: { deletedAt: null },
        select: { id: true, name: true },
        orderBy: { id: 'asc' },
      });
      const position = await tx.position.findFirst({
        where: { deletedAt: null },
        select: { id: true },
        orderBy: { id: 'asc' },
      });
      if (!position)
        throw new Error('At least one active position is required.');
      const plan = buildActivityPlan(options, menus, tables, position.id);
      if (
        await tx.dailySalesClose.count({
          where: {
            periodStart: { lt: plan.end },
            periodEnd: { gt: plan.start },
          },
        })
      )
        throw new Error(
          'Activity seed cannot restate already-closed business days.',
        );
      if (!apply)
        return { applied: false, alreadyApplied: false, summary: plan.summary };
      const d = plan.data;
      await tx.employee.create({ data: plan.employee });
      await tx.fund.create({
        data: {
          id: plan.fundId,
          name: 'Quy thu ngan 02',
          type: 'CASH',
          balance: plan.balance,
          createdAt: plan.start,
        },
      });
      await tx.supplier.create({
        data: {
          id: plan.supplierId,
          code: 'CH-LOCAL-ACTIVITY',
          name: 'Coffee Homes Supply',
          notes: SOURCE,
          createdAt: plan.start,
        },
      });
      await tx.customer.createMany({ data: d.customers });
      await tx.customerWishlist.createMany({ data: d.wishlists });
      await tx.purchaseReceipt.createMany({ data: d.receipts });
      await tx.purchaseReceiptItem.createMany({ data: d.receiptItems });
      await tx.cashierShift.createMany({ data: d.shifts });
      await tx.orderSession.createMany({ data: d.sessions });
      await tx.onlineOrderRequest.createMany({ data: d.requests });
      await tx.onlineOrderRequestItem.createMany({ data: d.requestItems });
      await tx.invoice.createMany({ data: d.invoices });
      await tx.orderItem.createMany({ data: d.items });
      await tx.orderItemRecipeIngredient.createMany({ data: d.recipes });
      await tx.orderItemIngredientSnapshot.createMany({ data: d.snapshots });
      await tx.inventoryTransaction.createMany({
        data: d.inventoryTransactions,
      });
      await tx.inventoryWaste.createMany({ data: d.waste });
      await tx.kitchenTicket.createMany({ data: d.tickets });
      await tx.kitchenTicketItem.createMany({ data: d.ticketItems });
      await tx.cashTransaction.createMany({ data: d.movements });
      await tx.cashRefund.createMany({ data: d.refunds });
      await tx.takeawayFeedback.createMany({ data: d.feedback });
      await tx.actionLog.createMany({ data: d.audit });
      for (const row of [...plan.stock.values()].sort((a, b) =>
        a.id.localeCompare(b.id),
      ))
        await tx.inventoryItem.update({
          where: { id: row.id },
          data: { stock: row.stock, averageUnitCost: row.averageUnitCost },
        });
      // Historical imports do not replay live outbox, notifications, payment callbacks or printing.
      await tx.actionLog.create({
        data: {
          id: id('completed'),
          employeeId: plan.actorId,
          actionType: 'LOCAL_ACTIVITY_SEEDED',
          requestId: SOURCE,
          details: { source: SOURCE, requestHash, summary: plan.summary },
        },
      });
      return { applied: true, alreadyApplied: false, summary: plan.summary };
    },
    {
      isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
      maxWait: 5000,
      timeout: 120000,
    },
  );
}
