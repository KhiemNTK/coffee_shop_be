import { assertDemoTarget, buildDemoData } from '../../../prisma/demo-data';

describe('Controlled demo data', () => {
  it('is reproducible, varies prices and stock, but keeps IDs stable across random seeds', () => {
    const first = buildDemoData(1);
    expect(buildDemoData(1)).toEqual(first);
    expect(buildDemoData(2).menuItems.map((item) => item.id)).toEqual(
      first.menuItems.map((item) => item.id),
    );
    expect(
      buildDemoData(2).menuItems.map((item) => item.price.toString()),
    ).not.toEqual(first.menuItems.map((item) => item.price.toString()));
    const ids = first.inventoryItems.map((item) => item.id);
    const menus = new Set(first.menuItems.map((item) => item.id));
    for (const item of first.menuItems)
      expect(item.price.isPositive()).toBe(true);
    for (const item of first.inventoryItems) {
      expect(item.stock.isPositive()).toBe(true);
      expect(item.averageUnitCost.isPositive()).toBe(true);
      expect(item.reorderPoint.lte(item.stock)).toBe(true);
    }
    for (const recipe of first.recipes) {
      expect(ids).toContain(recipe.inventoryItemId);
      expect(menus.has(recipe.menuItemId)).toBe(true);
      expect(recipe.quantity.gt(0)).toBe(true);
      expect(recipe.quantity.decimalPlaces()).toBeLessThanOrEqual(4);
    }
    expect(first.fund.balance.isZero()).toBe(true);
  });

  it.each([NaN, -1, 1.1, 4294967296])(
    'rejects invalid random seed %s',
    (seed) => {
      expect(() => buildDemoData(seed)).toThrow();
    },
  );

  it('requires explicit local database identity and rejects production even on loopback', () => {
    const local = 'postgresql://fixture:fixture@localhost:5432/demo_test';
    expect(() =>
      assertDemoTarget('development', local, 'demo_test'),
    ).not.toThrow();
    expect(() => assertDemoTarget('production', local, 'demo_test')).toThrow();
    expect(() => assertDemoTarget('development', local, undefined)).toThrow();
    expect(() =>
      assertDemoTarget('development', local, 'different_database'),
    ).toThrow();
    expect(() =>
      assertDemoTarget(
        'development',
        local.replace('localhost', 'remote.example'),
        'demo_test',
      ),
    ).toThrow();
  });
});
