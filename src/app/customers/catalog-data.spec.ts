import {
  assertCatalogTarget,
  buildCatalogData,
} from '../../../prisma/catalog-data';

describe('Coffee Homes catalog', () => {
  it('is reproducible, varies prices/reorder points and keeps IDs stable across random seeds', () => {
    const first = buildCatalogData(1);
    expect(buildCatalogData(1)).toEqual(first);
    expect(buildCatalogData(2).menuItems.map((item) => item.id)).toEqual(
      first.menuItems.map((item) => item.id),
    );
    expect(
      buildCatalogData(2).menuItems.map((item) => item.price.toString()),
    ).not.toEqual(first.menuItems.map((item) => item.price.toString()));
    expect(
      buildCatalogData(2).inventoryItems.map((item) =>
        item.reorderPoint.toString(),
      ),
    ).not.toEqual(
      first.inventoryItems.map((item) => item.reorderPoint.toString()),
    );
    const ids = first.inventoryItems.map((item) => item.id);
    const menus = new Set(first.menuItems.map((item) => item.id));
    for (const item of first.menuItems) {
      expect(item.price.isPositive()).toBe(true);
      expect(item.price.mod(5000).isZero()).toBe(true);
      expect(item.isAvailable).toBe(false);
      expect(item.description.length).toBeLessThanOrEqual(1000);
      expect(item.name).not.toMatch(/demo|sample/i);
      expect(item.description).not.toMatch(/demo|sample/i);
    }
    for (const item of first.inventoryItems) {
      expect(item.stock.isZero()).toBe(true);
      expect(item.averageUnitCost.isZero()).toBe(true);
      expect(item.reorderPoint.isPositive()).toBe(true);
      expect(item.name).not.toMatch(/demo|sample/i);
    }
    for (const recipe of first.recipes) {
      expect(ids).toContain(recipe.inventoryItemId);
      expect(menus.has(recipe.menuItemId)).toBe(true);
      expect(recipe.quantity.gt(0)).toBe(true);
      expect(recipe.quantity.decimalPlaces()).toBeLessThanOrEqual(4);
    }
    expect(new Set(first.menuItems.map((item) => item.id)).size).toBe(
      first.menuItems.length,
    );
    expect(new Set(first.inventoryItems.map((item) => item.id)).size).toBe(
      first.inventoryItems.length,
    );
  });

  it('uses item-specific recipes instead of milk in every coffee or one pastry SKU for all cakes', () => {
    const data = buildCatalogData(1);
    const ingredientsFor = (name: string) => {
      const item = data.menuItems.find((item) => item.name === name)!;
      return data.recipes
        .filter((recipe) => recipe.menuItemId === item.id)
        .map(
          (recipe) =>
            data.inventoryItems.find(
              (ingredient) => ingredient.id === recipe.inventoryItemId,
            )!.name,
        );
    };
    expect(ingredientsFor('Espresso')).toEqual(['Hạt cà phê rang']);
    expect(ingredientsFor('Latte')).toContain('Sữa tươi không đường');
    expect(ingredientsFor('Cà phê sữa đá')).toContain('Sữa đặc');
    expect(ingredientsFor('Croissant bơ')).toEqual(['Bánh croissant bơ']);
    expect(ingredientsFor('Bánh phô mai')).toEqual(['Bánh phô mai cắt miếng']);
    expect(data.menuItems).toHaveLength(44);
    expect(data.inventoryItems).toHaveLength(32);
    expect(data.tables).toHaveLength(10);
  });

  it.each([NaN, -1, 1.1, 4294967296])(
    'rejects invalid random seed %s',
    (seed) => {
      expect(() => buildCatalogData(seed)).toThrow();
    },
  );

  it('requires explicit local database identity and rejects production even on loopback', () => {
    const local = 'postgresql://fixture:fixture@localhost:5432/demo_test';
    expect(() =>
      assertCatalogTarget('development', local, 'demo_test'),
    ).not.toThrow();
    expect(() =>
      assertCatalogTarget('production', local, 'demo_test'),
    ).toThrow();
    expect(() =>
      assertCatalogTarget('development', local, undefined),
    ).toThrow();
    expect(() =>
      assertCatalogTarget('development', local, 'different_database'),
    ).toThrow();
    expect(() =>
      assertCatalogTarget(
        'development',
        local.replace('localhost', 'remote.example'),
        'demo_test',
      ),
    ).toThrow();
  });
});
