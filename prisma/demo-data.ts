import { createHash } from 'node:crypto';
import {
  FundType,
  InventoryTxType,
  Prisma,
  type PrismaClient,
} from '@prisma/client';

const demoId = (key: string) => {
  const bytes = createHash('sha256')
    .update(`coffee-shop:demo:v1:${key}`)
    .digest();
  bytes[6] = (bytes[6] & 15) | 64;
  bytes[8] = (bytes[8] & 63) | 128;
  const hex = bytes.subarray(0, 16).toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};

export function assertDemoTarget(
  environment: string | undefined,
  url: string,
  expectedDatabase: string | undefined,
) {
  const target = new URL(url);
  if (environment && !['development', 'test'].includes(environment))
    throw new Error('Demo seed is prohibited outside development/test.');
  if (
    !['postgres:', 'postgresql:'].includes(target.protocol) ||
    !['localhost', '127.0.0.1', '[::1]'].includes(target.hostname) ||
    !expectedDatabase ||
    decodeURIComponent(target.pathname.slice(1)) !== expectedDatabase
  )
    throw new Error(
      'Demo seed requires a loopback PostgreSQL URL and --database matching the exact target.',
    );
}

export function buildDemoData(seed: number) {
  if (!Number.isInteger(seed) || seed < 0 || seed > 0xffffffff)
    throw new Error('Demo seed must be a 32-bit unsigned integer.');
  let state = seed >>> 0;
  const integer = (min: number, max: number) => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return min + (state % (max - min + 1));
  };
  const units = ['kg', 'litre', 'piece'].map((name) => ({
    id: demoId(`unit:${name}`),
    name: `Demo ${name}`,
  }));
  const inventoryCategory = {
    id: demoId('inventory-category'),
    name: 'Demo ingredients',
    description: 'Sample data, not production inventory.',
  };
  const specifications = [
    ['Coffee beans', 0, 320000, 8, 15],
    ['Fresh milk', 1, 35000, 50, 90],
    ['Condensed milk', 1, 55000, 15, 25],
    ['Tea leaves', 0, 180000, 8, 15],
    ['Matcha powder', 0, 650000, 4, 8],
    ['Sugar', 0, 24000, 15, 30],
    ['Fruit syrup', 1, 90000, 15, 25],
    ['Pastry', 2, 18000, 80, 140],
  ] as const;
  const inventoryItems = specifications.map(([name, unit, cost, min, max]) => ({
    id: demoId(`ingredient:${name}`),
    name: `Demo ${name}`,
    unitId: units[unit].id,
    categoryId: inventoryCategory.id,
    stock: new Prisma.Decimal(integer(min, max)),
    averageUnitCost: new Prisma.Decimal(cost),
    reorderPoint: new Prisma.Decimal(min / 2),
  }));
  const stations = ['Drinks', 'Pastry'].map((name) => ({
    id: demoId(`station:${name}`),
    code: `DEMO_${name.toUpperCase()}`,
    name: `Demo ${name}`,
    isActive: true,
    prepSlaSeconds: 600,
  }));
  const categories = ['Coffee', 'Tea', 'Matcha', 'Pastry'].map((name) => ({
    id: demoId(`category:${name}`),
    name: `Demo ${name}`,
    description: 'Demo catalog',
  }));
  const products = [
    ['Espresso', 'Americano', 'Latte', 'Cappuccino', 'Milk coffee', 'Mocha'],
    [
      'Peach tea',
      'Lemon tea',
      'Black tea',
      'Lychee tea',
      'Milk tea',
      'Orange tea',
    ],
    [
      'Matcha latte',
      'Matcha milk',
      'Iced matcha',
      'Matcha cream',
      'Matcha espresso',
      'Matcha frappe',
    ],
    [
      'Croissant',
      'Chocolate cake',
      'Cheesecake',
      'Muffin',
      'Cookie',
      'Banana bread',
    ],
  ];
  const menuItems = products.flatMap((names, category) =>
    names.map((name) => ({
      id: demoId(`menu:${name}`),
      name: `Demo ${name}`,
      categoryId: categories[category].id,
      kitchenStationId: stations[category === 3 ? 1 : 0].id,
      price: new Prisma.Decimal(integer(category === 3 ? 25 : 30, 65) * 1000),
      description: `Demo ${name}. Sample menu for development and demonstrations.`,
      isAvailable: true,
    })),
  );
  const recipes = menuItems.flatMap((item, index) => {
    const category = Math.floor(index / 6);
    const quantities =
      category === 0
        ? [
            [0, '0.0180'],
            [1, '0.1200'],
          ]
        : category === 1
          ? [
              [3, '0.0080'],
              [6, '0.0250'],
            ]
          : category === 2
            ? [
                [4, '0.0040'],
                [1, '0.1800'],
              ]
            : [[7, '1.0000']];
    return quantities.map(([ingredient, quantity]) => ({
      menuItemId: item.id,
      inventoryItemId: inventoryItems[Number(ingredient)].id,
      quantity: new Prisma.Decimal(quantity),
    }));
  });
  const tables = Array.from({ length: 6 }, (_, index) => ({
    id: demoId(`table:${index + 1}`),
    name: `Demo Table ${String(index + 1).padStart(2, '0')}`,
  }));
  const fund = {
    id: demoId('cash-fund'),
    name: 'Demo Cash',
    type: FundType.CASH,
    balance: new Prisma.Decimal(0),
  };
  return {
    units,
    inventoryCategory,
    inventoryItems,
    stations,
    categories,
    menuItems,
    recipes,
    tables,
    fund,
  };
}

export async function seedDemo(prisma: PrismaClient, seed: number) {
  const data = buildDemoData(seed);
  return prisma.$transaction(
    async (tx) => {
      // Stable IDs make replay safe; never resurrect or overwrite a record changed by staff.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(20261013, 1)`;
      const existingStock = new Set(
        (
          await tx.inventoryItem.findMany({
            where: { id: { in: data.inventoryItems.map((item) => item.id) } },
            select: { id: true },
          })
        ).map((item) => item.id),
      );
      const existingMenu = new Set(
        (
          await tx.menuItem.findMany({
            where: { id: { in: data.menuItems.map((item) => item.id) } },
            select: { id: true },
          })
        ).map((item) => item.id),
      );
      const units = await tx.unit.createMany({
        data: data.units,
        skipDuplicates: true,
      });
      await tx.inventoryCategory.createMany({
        data: [data.inventoryCategory],
        skipDuplicates: true,
      });
      const stock = data.inventoryItems.filter(
        (item) => !existingStock.has(item.id),
      );
      const inventory = await tx.inventoryItem.createMany({
        data: stock,
        skipDuplicates: true,
      });
      await tx.inventoryTransaction.createMany({
        data: stock.map((item) => ({
          id: demoId(`initial-stock:${item.id}`),
          inventoryItemId: item.id,
          type: InventoryTxType.IMPORT,
          quantity: item.stock,
          unitPrice: item.averageUnitCost,
          totalAmount: item.stock.mul(item.averageUnitCost),
          transactionDate: new Date(),
          note: 'Demo opening stock. Not a supplier payment or business sale.',
        })),
      });
      await tx.kitchenStation.createMany({
        data: data.stations,
        skipDuplicates: true,
      });
      const categories = await tx.menuCategory.createMany({
        data: data.categories,
        skipDuplicates: true,
      });
      const menu = await tx.menuItem.createMany({
        data: data.menuItems.filter((item) => !existingMenu.has(item.id)),
        skipDuplicates: true,
      });
      await tx.menuItemIngredient.createMany({
        data: data.recipes.filter(
          (recipe) => !existingMenu.has(recipe.menuItemId),
        ),
        skipDuplicates: true,
      });
      const tables = await tx.diningTable.createMany({
        data: data.tables,
        skipDuplicates: true,
      });
      await tx.fund.createMany({ data: [data.fund], skipDuplicates: true });
      return {
        units: units.count,
        inventoryItems: inventory.count,
        menuCategories: categories.count,
        menuItems: menu.count,
        tables: tables.count,
      };
    },
    { timeout: 20000 },
  );
}
