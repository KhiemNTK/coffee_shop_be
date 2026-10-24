import { Prisma } from '@prisma/client';
import { buildActivityPlan } from '../../../prisma/activity-data';
import { buildCatalogData } from '../../../prisma/catalog-data';
import { readInvoiceSnapshot } from '../invoices/invoice-snapshot';

const decimal = (value: unknown) => new Prisma.Decimal(String(value));

function fixture(seed = 20261022) {
  const catalog = buildCatalogData(seed);
  const menus = catalog.menuItems.map((menu) => ({
    ...menu,
    kitchenStation: { prepSlaSeconds: 900 },
    ingredients: catalog.recipes
      .filter((r) => r.menuItemId === menu.id)
      .map((r) => {
        const item = catalog.inventoryItems.find(
          (row) => row.id === r.inventoryItemId,
        )!;
        return {
          quantity: r.quantity,
          inventoryItem: {
            ...item,
            deletedAt: null,
            reservedStock: new Prisma.Decimal(0),
            category: { deletedAt: null },
            unit: {
              name: catalog.units.find((unit) => unit.id === item.unitId)!.name,
              deletedAt: null,
            },
          },
        };
      }),
  }));
  return { menus, tables: catalog.tables };
}

describe('Local activity seed', () => {
  const options = { seed: 20261022, through: '2005-03-31' };
  const input = fixture();
  const build = () =>
    buildActivityPlan(options, input.menus, input.tables, 'position');

  it('is repeatable and creates 300 orders across 30 Vietnam days and 50 synthetic customers', () => {
    const first = build();
    expect(build()).toEqual(first);
    expect(first.summary.orders).toBe(300);
    expect(first.data.shifts).toHaveLength(30);
    expect(first.data.customers).toHaveLength(50);
    expect(first.start.toISOString()).toBe('2005-03-01T17:00:00.000Z');
    expect(first.end.toISOString()).toBe('2005-03-31T17:00:00.000Z');
    expect(first.employee.isActive).toBe(false);
    expect(
      first.data.customers.every((r) => r.email.endsWith('.example.test')),
    ).toBe(true);
    expect(new Set(first.data.customers.map((r) => r.id)).size).toBe(50);
    expect(
      buildActivityPlan(
        { ...options, seed: 7 },
        input.menus,
        input.tables,
        'position',
      ).summary,
    ).not.toEqual(first.summary);
  });

  it.each([0, 1, 20261022])(
    'balances every stock movement and cost snapshot (seed %s)',
    (seed) => {
      const plan = buildActivityPlan(
        { ...options, seed },
        input.menus,
        input.tables,
        'position',
      );
      for (const item of plan.stock.values()) {
        const net = plan.data.inventoryTransactions
          .filter((r) => r.inventoryItemId === item.id)
          .reduce(
            (sum, r) =>
              r.type === 'IMPORT'
                ? sum.add(decimal(r.quantity))
                : sum.sub(decimal(r.quantity)),
            new Prisma.Decimal(0),
          );
        expect(net.eq(item.stock)).toBe(true);
        expect(item.stock.gte(0)).toBe(true);
        expect(item.averageUnitCost.gt(0)).toBe(true);
      }
      for (const row of plan.data.snapshots) {
        const quantity = decimal(row.totalQuantity);
        expect(
          quantity
            .mul(decimal(row.unitCost))
            .toDecimalPlaces(2)
            .eq(decimal(row.totalCost)),
        ).toBe(true);
        const item = plan.data.items.find((i) => i.id === row.orderItemId)!;
        expect(
          decimal(row.quantityPerItem).mul(item.quantity).eq(quantity),
        ).toBe(true);
      }
      for (const row of plan.data.waste) {
        const item = plan.data.items.find((i) => i.id === row.orderItemId)!;
        expect(item.serveStatus).toBe('CANCELLED');
        expect(item.isPaid).toBe(false);
        expect(item.invoiceId).toBeNull();
      }
      expect(plan.data.receipts).toHaveLength(5);
    },
  );

  it('reconciles invoices, refunds, all closed shifts and the isolated cash fund', () => {
    const plan = build();
    let balance = new Prisma.Decimal(500000);
    for (const shift of plan.data.shifts) {
      expect(shift.status).toBe('CLOSED');
      expect(decimal(shift.expectedStartingCash).eq(balance)).toBe(true);
      balance = plan.data.movements
        .filter((r) => r.shiftId === shift.id)
        .reduce(
          (sum, r) =>
            r.type === 'INCOME'
              ? sum.add(decimal(r.amount))
              : sum.sub(decimal(r.amount)),
          balance,
        );
      expect(balance.eq(decimal(shift.actualEndingCash))).toBe(true);
      expect(balance.eq(decimal(shift.reportedEndingCash))).toBe(true);
    }
    expect(balance.eq(plan.balance)).toBe(true);
    for (const invoice of plan.data.invoices) {
      const snapshot = readInvoiceSnapshot(invoice.documentSnapshot)!;
      expect(snapshot.source).toBe('ISSUED');
      expect(snapshot.items.length).toBeGreaterThan(0);
      expect(
        snapshot.items
          .reduce(
            (sum, item) => sum.add(decimal(item.unitPrice).mul(item.quantity)),
            decimal(0),
          )
          .eq(invoice.totalAmount),
      ).toBe(true);
      const subtotal = plan.data.items
        .filter((r) => r.invoiceId === invoice.id)
        .reduce(
          (sum, r) => sum.add(decimal(r.priceAtTime).mul(r.quantity)),
          new Prisma.Decimal(0),
        );
      expect(subtotal.eq(decimal(invoice.subTotal))).toBe(true);
      expect(subtotal.eq(decimal(invoice.totalAmount))).toBe(true);
      const sale = plan.data.movements.find((r) => r.invoiceId === invoice.id)!;
      expect(decimal(sale.amount).eq(subtotal)).toBe(true);
      const refunds = plan.data.refunds
        .filter((r) => r.invoiceId === invoice.id)
        .reduce((sum, r) => sum.add(decimal(r.amount)), new Prisma.Decimal(0));
      expect(refunds.lte(subtotal)).toBe(true);
    }
    expect(plan.data.refunds.length).toBeGreaterThan(0);
  });

  it('matches COD quotes and customer ownership without creating external provider/session rows', () => {
    const plan = build();
    for (const request of plan.data.requests) {
      const quoted = plan.data.requestItems
        .filter((r) => r.onlineOrderRequestId === request.id)
        .reduce(
          (sum, r) => sum.add(decimal(r.quotedUnitPrice).mul(r.quantity)),
          new Prisma.Decimal(0),
        );
      expect(quoted.eq(decimal(request.quotedSubtotal))).toBe(true);
      expect(
        plan.data.requestItems
          .filter((r) => r.onlineOrderRequestId === request.id)
          .map((r) => r.lineNumber),
      ).toEqual(
        plan.data.requestItems
          .filter((r) => r.onlineOrderRequestId === request.id)
          .map((_, index) => index + 1),
      );
      expect(plan.data.customers.some((r) => r.id === request.customerId)).toBe(
        true,
      );
      if (request.status === 'ACCEPTED') {
        const invoice = plan.data.invoices.find(
          (r) => r.orderSessionId === request.orderSessionId,
        )!;
        expect(quoted.eq(decimal(invoice.totalAmount))).toBe(true);
      }
    }
    expect(Object.keys(plan.data)).not.toEqual(
      expect.arrayContaining(['outbox', 'paymentAttempts', 'customerSessions']),
    );
    for (const item of plan.data.items) {
      if (item.serveStatus === 'SERVED') expect(item.isPaid).toBe(true);
      else expect(item.invoiceId).toBeNull();
    }
  });

  it('rejects future periods and refuses to consume existing reservations', () => {
    expect(() =>
      buildActivityPlan(
        { ...options, through: '2999-01-01' },
        input.menus,
        input.tables,
        'position',
      ),
    ).toThrow();
    const held = fixture();
    const ingredientId = held.menus[0].ingredients[0].inventoryItem.id;
    for (const menu of held.menus)
      for (const ingredient of menu.ingredients)
        if (ingredient.inventoryItem.id === ingredientId)
          ingredient.inventoryItem.reservedStock = new Prisma.Decimal(1);
    expect(() =>
      buildActivityPlan(options, held.menus, held.tables, 'position'),
    ).toThrow(/outstanding holds/);
  });
});
