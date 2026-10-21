import { createHash } from 'node:crypto';
import { Prisma, type PrismaClient } from '@prisma/client';

const seedId = (namespace: 'catalog' | 'demo', key: string) => {
  const bytes = createHash('sha256')
    .update(`coffee-shop:${namespace}:v1:${key}`)
    .digest();
  bytes[6] = (bytes[6] & 15) | 64;
  bytes[8] = (bytes[8] & 63) | 128;
  const hex = bytes.subarray(0, 16).toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};
const catalogId = (key: string) => seedId('catalog', key);

export function assertCatalogTarget(
  environment: string | undefined,
  url: string,
  expectedDatabase: string | undefined,
) {
  const target = new URL(url);
  if (environment && !['development', 'test'].includes(environment))
    throw new Error('Catalog seed is prohibited outside development/test.');
  if (
    !['postgres:', 'postgresql:'].includes(target.protocol) ||
    !['localhost', '127.0.0.1', '[::1]'].includes(target.hostname) ||
    !expectedDatabase ||
    decodeURIComponent(target.pathname.slice(1)) !== expectedDatabase
  )
    throw new Error(
      'Catalog seed requires a loopback PostgreSQL URL and --database matching the exact target.',
    );
}

export function buildCatalogData(seed: number) {
  if (!Number.isInteger(seed) || seed < 0 || seed > 0xffffffff)
    throw new Error('Catalog seed must be a 32-bit unsigned integer.');
  let state = seed >>> 0;
  const integer = (min: number, max: number) => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return min + (state % (max - min + 1));
  };
  const units = ['kg', 'lít', 'cái'].map((name) => ({
    id: catalogId(`unit:${name}`),
    name,
  }));
  const inventoryCategory = {
    id: catalogId('inventory-category'),
    name: 'Nguyên liệu pha chế và bánh',
    description: 'Nguyên liệu định lượng theo kg, lít hoặc cái.',
  };
  const specifications = [
    // Reference prices guide selling prices; they are not booked inventory costs.
    ['Coffee beans', 0, 320000, 2, 4],
    ['Fresh milk', 1, 35000, 8, 15],
    ['Condensed milk', 1, 55000, 3, 6],
    ['Tea leaves', 0, 180000, 1, 2],
    ['Matcha powder', 0, 650000, 1, 2],
    ['Sugar', 0, 24000, 3, 5],
    ['Butter croissant', 2, 15000, 8, 15],
    ['Chocolate cake slice', 2, 18000, 8, 15],
    ['Cheesecake slice', 2, 18000, 8, 15],
    ['Muffin', 2, 12000, 10, 20],
    ['Cookie', 2, 8000, 10, 20],
    ['Banana bread slice', 2, 12000, 8, 15],
    ['Coconut milk', 1, 60000, 3, 6],
    ['Peach syrup', 1, 100000, 2, 4],
    ['Lychee syrup', 1, 110000, 2, 4],
    ['Orange juice', 1, 70000, 3, 5],
    ['Lemon juice', 1, 80000, 1, 3],
    ['Whipping cream', 1, 150000, 2, 4],
    ['Cocoa powder', 0, 180000, 1, 2],
    ['Mango pulp', 0, 65000, 2, 4],
    ['Avocado pulp', 0, 85000, 2, 4],
    ['Strawberry pulp', 0, 110000, 2, 4],
    ['Yogurt', 1, 50000, 3, 6],
    ['Honey', 0, 180000, 1, 2],
    ['Lemongrass', 0, 25000, 1, 2],
    ['Lotus seeds', 0, 110000, 1, 3],
    ['Jasmine tea', 0, 220000, 1, 2],
    ['Cream cheese', 0, 180000, 1, 2],
    ['Tiramisu slice', 2, 22000, 8, 15],
    ['Cream puff', 2, 12000, 10, 20],
    ['Brownie', 2, 15000, 10, 20],
    ['Panna cotta', 2, 17000, 8, 15],
  ] as const;
  const ingredientNames: Record<(typeof specifications)[number][0], string> = {
    'Coffee beans': 'Hạt cà phê rang',
    'Fresh milk': 'Sữa tươi không đường',
    'Condensed milk': 'Sữa đặc',
    'Tea leaves': 'Hồng trà',
    'Matcha powder': 'Bột matcha',
    Sugar: 'Đường trắng',
    'Butter croissant': 'Bánh croissant bơ',
    'Chocolate cake slice': 'Bánh sô cô la cắt miếng',
    'Cheesecake slice': 'Bánh phô mai cắt miếng',
    Muffin: 'Bánh muffin',
    Cookie: 'Bánh quy bơ',
    'Banana bread slice': 'Bánh chuối cắt miếng',
    'Coconut milk': 'Nước cốt dừa',
    'Peach syrup': 'Siro đào',
    'Lychee syrup': 'Siro vải',
    'Orange juice': 'Nước cam nguyên chất',
    'Lemon juice': 'Nước cốt chanh',
    'Whipping cream': 'Kem sữa béo',
    'Cocoa powder': 'Bột cacao',
    'Mango pulp': 'Thịt xoài',
    'Avocado pulp': 'Thịt bơ',
    'Strawberry pulp': 'Dâu tây nghiền',
    Yogurt: 'Sữa chua',
    Honey: 'Mật ong',
    Lemongrass: 'Sả tươi',
    'Lotus seeds': 'Hạt sen',
    'Jasmine tea': 'Trà lài',
    'Cream cheese': 'Phô mai kem',
    'Tiramisu slice': 'Bánh tiramisu cắt miếng',
    'Cream puff': 'Bánh su kem',
    Brownie: 'Bánh brownie',
    'Panna cotta': 'Bánh panna cotta',
  };
  const inventoryItems = specifications.map(([name, unit, , min, max]) => ({
    id: catalogId(`ingredient:${name}`),
    name: ingredientNames[name],
    unitId: units[unit].id,
    categoryId: inventoryCategory.id,
    stock: new Prisma.Decimal(0),
    averageUnitCost: new Prisma.Decimal(0),
    reorderPoint: new Prisma.Decimal(integer(min, max)),
  }));
  const stations = ['Drinks', 'Pastry'].map((name) => ({
    // Retain identities so existing kitchen tickets do not change station.
    id: seedId('demo', `station:${name}`),
    code: name === 'Drinks' ? 'BAR' : 'PASTRY',
    name: name === 'Drinks' ? 'Quầy pha chế' : 'Quầy bánh',
    isActive: true,
    prepSlaSeconds: name === 'Pastry' ? 180 : 480,
  }));
  const categoryNames = [
    'Coffee',
    'Tea',
    'Matcha',
    'Pastry',
    'Fruit Drinks',
  ] as const;
  const categoryLabels = [
    'Cà phê',
    'Trà',
    'Matcha',
    'Bánh ngọt',
    'Nước ép và sinh tố',
  ];
  const categories = categoryNames.map((name, index) => ({
    id: catalogId(`category:${name}`),
    name: categoryLabels[index],
    description: `${categoryLabels[index]} tại Coffee Homes.`,
  }));
  const products: {
    name: string;
    category: (typeof categoryNames)[number];
    price: readonly [number, number];
    recipe: ReadonlyArray<
      readonly [(typeof specifications)[number][0], string]
    >;
  }[] = [
    {
      name: 'Espresso',
      category: 'Coffee',
      price: [30, 35],
      recipe: [['Coffee beans', '0.0180']],
    },
    {
      name: 'Americano',
      category: 'Coffee',
      price: [30, 40],
      recipe: [['Coffee beans', '0.0180']],
    },
    {
      name: 'Latte',
      category: 'Coffee',
      price: [40, 50],
      recipe: [
        ['Coffee beans', '0.0180'],
        ['Fresh milk', '0.1800'],
      ],
    },
    {
      name: 'Cappuccino',
      category: 'Coffee',
      price: [40, 50],
      recipe: [
        ['Coffee beans', '0.0180'],
        ['Fresh milk', '0.1200'],
      ],
    },
    {
      name: 'Milk coffee',
      category: 'Coffee',
      price: [30, 40],
      recipe: [
        ['Coffee beans', '0.0200'],
        ['Condensed milk', '0.0300'],
      ],
    },
    {
      name: 'Mocha',
      category: 'Coffee',
      price: [45, 55],
      recipe: [
        ['Coffee beans', '0.0180'],
        ['Fresh milk', '0.1500'],
        ['Cocoa powder', '0.0120'],
      ],
    },
    {
      name: 'Peach tea',
      category: 'Tea',
      price: [35, 45],
      recipe: [
        ['Tea leaves', '0.0060'],
        ['Peach syrup', '0.0300'],
      ],
    },
    {
      name: 'Lemon tea',
      category: 'Tea',
      price: [25, 35],
      recipe: [
        ['Tea leaves', '0.0060'],
        ['Lemon juice', '0.0200'],
        ['Sugar', '0.0150'],
      ],
    },
    {
      name: 'Black tea',
      category: 'Tea',
      price: [25, 30],
      recipe: [['Tea leaves', '0.0060']],
    },
    {
      name: 'Lychee tea',
      category: 'Tea',
      price: [35, 45],
      recipe: [
        ['Tea leaves', '0.0060'],
        ['Lychee syrup', '0.0300'],
      ],
    },
    {
      name: 'Milk tea',
      category: 'Tea',
      price: [35, 45],
      recipe: [
        ['Tea leaves', '0.0080'],
        ['Fresh milk', '0.1200'],
        ['Sugar', '0.0150'],
      ],
    },
    {
      name: 'Orange tea',
      category: 'Tea',
      price: [35, 45],
      recipe: [
        ['Tea leaves', '0.0060'],
        ['Orange juice', '0.0600'],
      ],
    },
    {
      name: 'Matcha latte',
      category: 'Matcha',
      price: [45, 55],
      recipe: [
        ['Matcha powder', '0.0040'],
        ['Fresh milk', '0.1800'],
      ],
    },
    {
      name: 'Matcha milk',
      category: 'Matcha',
      price: [40, 50],
      recipe: [
        ['Matcha powder', '0.0035'],
        ['Fresh milk', '0.1200'],
        ['Condensed milk', '0.0200'],
      ],
    },
    {
      name: 'Iced matcha',
      category: 'Matcha',
      price: [35, 45],
      recipe: [
        ['Matcha powder', '0.0030'],
        ['Sugar', '0.0150'],
      ],
    },
    {
      name: 'Matcha cream',
      category: 'Matcha',
      price: [50, 60],
      recipe: [
        ['Matcha powder', '0.0040'],
        ['Fresh milk', '0.1400'],
        ['Whipping cream', '0.0300'],
      ],
    },
    {
      name: 'Matcha espresso',
      category: 'Matcha',
      price: [50, 60],
      recipe: [
        ['Matcha powder', '0.0030'],
        ['Coffee beans', '0.0180'],
        ['Fresh milk', '0.1200'],
      ],
    },
    {
      name: 'Matcha frappe',
      category: 'Matcha',
      price: [50, 60],
      recipe: [
        ['Matcha powder', '0.0050'],
        ['Fresh milk', '0.1200'],
        ['Whipping cream', '0.0200'],
        ['Sugar', '0.0150'],
      ],
    },
    {
      name: 'Croissant',
      category: 'Pastry',
      price: [30, 40],
      recipe: [['Butter croissant', '1.0000']],
    },
    {
      name: 'Chocolate cake',
      category: 'Pastry',
      price: [35, 45],
      recipe: [['Chocolate cake slice', '1.0000']],
    },
    {
      name: 'Cheesecake',
      category: 'Pastry',
      price: [35, 45],
      recipe: [['Cheesecake slice', '1.0000']],
    },
    {
      name: 'Muffin',
      category: 'Pastry',
      price: [25, 35],
      recipe: [['Muffin', '1.0000']],
    },
    {
      name: 'Cookie',
      category: 'Pastry',
      price: [15, 25],
      recipe: [['Cookie', '1.0000']],
    },
    {
      name: 'Banana bread',
      category: 'Pastry',
      price: [25, 35],
      recipe: [['Banana bread slice', '1.0000']],
    },
    {
      name: 'Cà phê phin đen đá',
      category: 'Coffee',
      price: [25, 35],
      recipe: [
        ['Coffee beans', '0.0250'],
        ['Sugar', '0.0100'],
      ],
    },
    {
      name: 'Cà phê sữa đá',
      category: 'Coffee',
      price: [30, 40],
      recipe: [
        ['Coffee beans', '0.0250'],
        ['Condensed milk', '0.0300'],
      ],
    },
    {
      name: 'Bạc xỉu',
      category: 'Coffee',
      price: [35, 45],
      recipe: [
        ['Coffee beans', '0.0120'],
        ['Fresh milk', '0.1000'],
        ['Condensed milk', '0.0250'],
      ],
    },
    {
      name: 'Cà phê dừa',
      category: 'Coffee',
      price: [40, 50],
      recipe: [
        ['Coffee beans', '0.0200'],
        ['Coconut milk', '0.0800'],
        ['Condensed milk', '0.0200'],
      ],
    },
    {
      name: 'Cold brew cam',
      category: 'Coffee',
      price: [45, 55],
      recipe: [
        ['Coffee beans', '0.0250'],
        ['Orange juice', '0.0600'],
        ['Sugar', '0.0100'],
      ],
    },
    {
      name: 'Trà đào cam sả',
      category: 'Tea',
      price: [40, 50],
      recipe: [
        ['Tea leaves', '0.0060'],
        ['Peach syrup', '0.0300'],
        ['Orange juice', '0.0300'],
        ['Lemongrass', '0.0050'],
      ],
    },
    {
      name: 'Trà vải hoa nhài',
      category: 'Tea',
      price: [40, 50],
      recipe: [
        ['Jasmine tea', '0.0060'],
        ['Lychee syrup', '0.0300'],
      ],
    },
    {
      name: 'Trà sen vàng',
      category: 'Tea',
      price: [40, 50],
      recipe: [
        ['Tea leaves', '0.0060'],
        ['Lotus seeds', '0.0300'],
        ['Whipping cream', '0.0250'],
      ],
    },
    {
      name: 'Hồng trà chanh mật ong',
      category: 'Tea',
      price: [35, 45],
      recipe: [
        ['Tea leaves', '0.0060'],
        ['Lemon juice', '0.0200'],
        ['Honey', '0.0200'],
      ],
    },
    {
      name: 'Matcha latte dừa',
      category: 'Matcha',
      price: [50, 60],
      recipe: [
        ['Matcha powder', '0.0040'],
        ['Coconut milk', '0.1200'],
        ['Fresh milk', '0.0600'],
      ],
    },
    {
      name: 'Matcha kem cheese',
      category: 'Matcha',
      price: [50, 60],
      recipe: [
        ['Matcha powder', '0.0040'],
        ['Fresh milk', '0.1500'],
        ['Cream cheese', '0.0250'],
      ],
    },
    {
      name: 'Matcha cacao',
      category: 'Matcha',
      price: [50, 60],
      recipe: [
        ['Matcha powder', '0.0030'],
        ['Cocoa powder', '0.0120'],
        ['Fresh milk', '0.1500'],
      ],
    },
    {
      name: 'Sinh tố xoài',
      category: 'Fruit Drinks',
      price: [45, 55],
      recipe: [
        ['Mango pulp', '0.1500'],
        ['Fresh milk', '0.0800'],
        ['Condensed milk', '0.0200'],
      ],
    },
    {
      name: 'Sinh tố bơ',
      category: 'Fruit Drinks',
      price: [50, 60],
      recipe: [
        ['Avocado pulp', '0.1500'],
        ['Fresh milk', '0.0800'],
        ['Condensed milk', '0.0200'],
      ],
    },
    {
      name: 'Sữa chua dâu',
      category: 'Fruit Drinks',
      price: [45, 55],
      recipe: [
        ['Yogurt', '0.1200'],
        ['Strawberry pulp', '0.0800'],
        ['Sugar', '0.0100'],
      ],
    },
    {
      name: 'Nước cam ép',
      category: 'Fruit Drinks',
      price: [40, 50],
      recipe: [['Orange juice', '0.2500']],
    },
    {
      name: 'Bánh tiramisu',
      category: 'Pastry',
      price: [35, 45],
      recipe: [['Tiramisu slice', '1.0000']],
    },
    {
      name: 'Bánh su kem',
      category: 'Pastry',
      price: [20, 30],
      recipe: [['Cream puff', '1.0000']],
    },
    {
      name: 'Bánh brownie',
      category: 'Pastry',
      price: [25, 35],
      recipe: [['Brownie', '1.0000']],
    },
    {
      name: 'Bánh panna cotta',
      category: 'Pastry',
      price: [30, 40],
      recipe: [['Panna cotta', '1.0000']],
    },
  ];
  const productNames: Record<string, string> = {
    'Milk coffee': 'Cà phê sữa nóng',
    'Peach tea': 'Trà đào',
    'Lemon tea': 'Trà chanh',
    'Black tea': 'Hồng trà nguyên chất',
    'Lychee tea': 'Trà vải',
    'Milk tea': 'Trà sữa truyền thống',
    'Orange tea': 'Hồng trà cam',
    'Matcha milk': 'Matcha sữa đặc',
    'Iced matcha': 'Matcha nguyên chất đá',
    'Matcha cream': 'Matcha kem sữa',
    'Matcha frappe': 'Matcha đá xay',
    Croissant: 'Croissant bơ',
    'Chocolate cake': 'Bánh sô cô la',
    Cheesecake: 'Bánh phô mai',
    Muffin: 'Muffin',
    Cookie: 'Bánh quy bơ',
    'Banana bread': 'Bánh chuối',
  };
  const ingredientCosts = new Map(
    specifications.map(([name, , cost]) => [name, new Prisma.Decimal(cost)]),
  );
  const menuItems = products.map((product) => {
    const referenceCost = product.recipe.reduce(
      (total, [ingredient, quantity]) =>
        total.add(ingredientCosts.get(ingredient)!.mul(quantity)),
      new Prisma.Decimal(0),
    );
    const minPrice = Math.max(
      product.price[0],
      Math.ceil(
        referenceCost
          .div(product.category === 'Pastry' ? '0.70' : '0.40')
          .toNumber() / 5000,
      ) * 5,
    );
    if (minPrice > product.price[1])
      throw new Error(`Invalid catalog price range: ${product.name}`);
    return {
      id: catalogId(`menu:${product.name}`),
      name: productNames[product.name] ?? product.name,
      categoryId: catalogId(`category:${product.category}`),
      kitchenStationId: stations[product.category === 'Pastry' ? 1 : 0].id,
      price: new Prisma.Decimal(
        integer(minPrice / 5, product.price[1] / 5) * 5000,
      ),
      description: `${productNames[product.name] ?? product.name}. Thành phần: ${product.recipe.map(([ingredient]) => ingredientNames[ingredient].toLocaleLowerCase('vi')).join(', ')}.`,
      isAvailable: false,
    };
  });
  const recipes = products.flatMap((product) =>
    product.recipe.map(([ingredient, quantity]) => ({
      menuItemId: catalogId(`menu:${product.name}`),
      inventoryItemId: catalogId(`ingredient:${ingredient}`),
      quantity: new Prisma.Decimal(quantity),
    })),
  );
  const tables = Array.from({ length: 10 }, (_, index) => ({
    // Keep open table sessions attached to the same table.
    id: seedId('demo', `table:${index + 1}`),
    name: `Bàn ${String(index + 1).padStart(2, '0')}`,
  }));
  return {
    units,
    inventoryCategory,
    inventoryItems,
    stations,
    categories,
    menuItems,
    recipes,
    tables,
  };
}

async function removeLegacyDemo(
  tx: Prisma.TransactionClient,
  catalog: ReturnType<typeof buildCatalogData>,
) {
  const demoName = { startsWith: 'Demo ' };
  const owned = (rows: { id: string; name: string }[], prefix: string) =>
    rows
      .filter(
        (row) => row.id === seedId('demo', `${prefix}:${row.name.slice(5)}`),
      )
      .map((row) => row.id);
  const deletedAt = new Date();
  // Block catalog edits during this explicit local maintenance operation.
  await tx.$executeRaw`LOCK TABLE "MenuItem", "InventoryItem", "DiningTable", "KitchenStation", "Fund" IN SHARE ROW EXCLUSIVE MODE`;
  const menus = await tx.menuItem.findMany({
    where: { name: demoName },
    select: {
      id: true,
      name: true,
      _count: {
        select: {
          orderItems: true,
          onlineOrderRequestItems: true,
          customerWishlists: true,
          optionGroups: true,
          recommendationAnchors: true,
          recommendationCandidates: true,
        },
      },
    },
  });
  const menuIds = owned(menus, 'menu');
  // The image migration may not have been deployed on an older local database.
  const [images] = await tx.$queryRaw<{ present: boolean }[]>`
    SELECT to_regclass('"MenuImageUpload"') IS NOT NULL AS present
  `;
  const imageMenuIds = new Set(
    images.present
      ? (
          await tx.menuImageUpload.findMany({
            where: { menuItemId: { in: menuIds } },
            select: { menuItemId: true },
          })
        ).map((image) => image.menuItemId)
      : [],
  );
  const unusedMenuIds = menus
    .filter(
      (row) =>
        menuIds.includes(row.id) &&
        !imageMenuIds.has(row.id) &&
        Object.values(row._count).every((count) => count === 0),
    )
    .map((row) => row.id);
  await tx.menuItemIngredient.deleteMany({
    where: { menuItemId: { in: unusedMenuIds } },
  });
  const removedMenus = await tx.menuItem.deleteMany({
    where: { id: { in: unusedMenuIds } },
  });
  const archivedMenus = await tx.menuItem.updateMany({
    where: { id: { in: menuIds }, deletedAt: null },
    data: { deletedAt, isAvailable: false },
  });

  const inventoryIds = owned(
    await tx.inventoryItem.findMany({
      where: { name: demoName },
      select: { id: true, name: true },
    }),
    'ingredient',
  );
  const removedInventory = await tx.inventoryItem.deleteMany({
    where: {
      id: { in: inventoryIds },
      stock: 0,
      reservedStock: 0,
      averageUnitCost: 0,
      ingredients: { none: {} },
      optionIngredients: { none: {} },
      orderRecipes: { none: {} },
      transactions: { none: {} },
      snapshots: { none: {} },
      receiptItems: { none: {} },
      stocktakeItems: { none: {} },
    },
  });
  const archivedInventory = await tx.inventoryItem.updateMany({
    where: {
      id: { in: inventoryIds },
      deletedAt: null,
      reservedStock: 0,
      ingredients: { none: { menuItem: { deletedAt: null } } },
      optionIngredients: {
        none: { option: { group: { menuItem: { deletedAt: null } } } },
      },
    },
    data: { deletedAt },
  });

  const categoryIds = owned(
    await tx.menuCategory.findMany({
      where: { name: demoName },
      select: { id: true, name: true },
    }),
    'category',
  );
  const removedCategories = await tx.menuCategory.deleteMany({
    where: { id: { in: categoryIds }, menuItems: { none: {} } },
  });
  const archivedCategories = await tx.menuCategory.updateMany({
    where: {
      id: { in: categoryIds },
      deletedAt: null,
      menuItems: { none: { deletedAt: null } },
    },
    data: { deletedAt },
  });
  const removedInventoryCategories = await tx.inventoryCategory.deleteMany({
    where: {
      id: seedId('demo', 'inventory-category'),
      name: 'Demo ingredients',
      inventoryItems: { none: {} },
    },
  });
  const archivedInventoryCategories = await tx.inventoryCategory.updateMany({
    where: {
      id: seedId('demo', 'inventory-category'),
      name: 'Demo ingredients',
      deletedAt: null,
      inventoryItems: { none: { deletedAt: null } },
    },
    data: { deletedAt },
  });
  const unitIds = owned(
    await tx.unit.findMany({
      where: { name: demoName },
      select: { id: true, name: true },
    }),
    'unit',
  );
  const removedUnits = await tx.unit.deleteMany({
    where: { id: { in: unitIds }, inventoryItems: { none: {} } },
  });
  const archivedUnits = await tx.unit.updateMany({
    where: {
      id: { in: unitIds },
      deletedAt: null,
      inventoryItems: { none: { deletedAt: null } },
    },
    data: { deletedAt },
  });

  let renamedTables = 0;
  for (const [index, table] of catalog.tables.entries()) {
    const renamed = await tx.diningTable.updateMany({
      where: {
        id: table.id,
        name: `Demo Table ${String(index + 1).padStart(2, '0')}`,
        deletedAt: null,
      },
      data: { name: table.name },
    });
    renamedTables += renamed.count;
  }
  let renamedStations = 0;
  for (const [index, station] of catalog.stations.entries()) {
    const name = index === 0 ? 'Drinks' : 'Pastry';
    const renamed = await tx.kitchenStation.updateMany({
      where: {
        id: station.id,
        name: `Demo ${name}`,
        code: `DEMO_${name.toUpperCase()}`,
        deletedAt: null,
      },
      data: { name: station.name, code: station.code },
    });
    renamedStations += renamed.count;
  }
  const renamedFunds = await tx.fund.updateMany({
    where: {
      id: seedId('demo', 'cash-fund'),
      name: 'Demo Cash',
      type: 'CASH',
      deletedAt: null,
    },
    data: { name: 'Tiền mặt tại quầy' },
  });
  return {
    deletedMenuItems: removedMenus.count,
    archivedMenuItems: archivedMenus.count,
    deletedInventoryItems: removedInventory.count,
    archivedInventoryItems: archivedInventory.count,
    deletedMenuCategories: removedCategories.count,
    archivedMenuCategories: archivedCategories.count,
    deletedInventoryCategories: removedInventoryCategories.count,
    archivedInventoryCategories: archivedInventoryCategories.count,
    deletedUnits: removedUnits.count,
    archivedUnits: archivedUnits.count,
    renamedTables,
    renamedStations,
    renamedFunds: renamedFunds.count,
  };
}

export async function seedCatalog(
  prisma: PrismaClient,
  seed: number,
  replaceDemo = false,
) {
  const data = buildCatalogData(seed);
  return prisma.$transaction(
    async (tx) => {
      // Stable IDs make replay safe; never resurrect or overwrite a record changed by staff.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(20261013, 1)`;
      const cleanup = replaceDemo
        ? await removeLegacyDemo(tx, data)
        : undefined;
      const existingMenu = new Set(
        (
          await tx.menuItem.findMany({
            where: { id: { in: data.menuItems.map((item) => item.id) } },
            select: { id: true },
          })
        ).map((item) => item.id),
      );
      const newItems = data.menuItems.filter(
        (item) => !existingMenu.has(item.id),
      );
      const newRecipes = data.recipes.filter(
        (recipe) => !existingMenu.has(recipe.menuItemId),
      );
      const requiredIngredients = new Set(
        newRecipes.map((recipe) => recipe.inventoryItemId),
      );
      const units = await tx.unit.createMany({
        data: data.units,
        skipDuplicates: true,
      });
      const inventoryCategories = await tx.inventoryCategory.createMany({
        data: [data.inventoryCategory],
        skipDuplicates: true,
      });
      const inventory = await tx.inventoryItem.createMany({
        data: data.inventoryItems.filter((item) =>
          requiredIngredients.has(item.id),
        ),
        skipDuplicates: true,
      });
      const stations = await tx.kitchenStation.createMany({
        data: data.stations,
        skipDuplicates: true,
      });
      const categories = await tx.menuCategory.createMany({
        data: data.categories,
        skipDuplicates: true,
      });
      const menu = await tx.menuItem.createMany({
        data: newItems,
        skipDuplicates: true,
      });
      const recipes = await tx.menuItemIngredient.createMany({
        data: newRecipes,
        skipDuplicates: true,
      });
      const invalid = await tx.menuItem.findFirst({
        where: {
          id: { in: newItems.map((item) => item.id) },
          OR: [
            { category: { deletedAt: { not: null } } },
            {
              kitchenStation: {
                OR: [{ deletedAt: { not: null } }, { isActive: false }],
              },
            },
            {
              ingredients: {
                some: {
                  inventoryItem: {
                    OR: [
                      { deletedAt: { not: null } },
                      { unit: { deletedAt: { not: null } } },
                      { category: { deletedAt: { not: null } } },
                    ],
                  },
                },
              },
            },
          ],
        },
        select: { id: true },
      });
      if (invalid)
        throw new Error(
          'Catalog references inactive data. No changes were committed.',
        );
      const tables = await tx.diningTable.createMany({
        data: data.tables,
        skipDuplicates: true,
      });
      return {
        units: units.count,
        inventoryItems: inventory.count,
        inventoryCategories: inventoryCategories.count,
        kitchenStations: stations.count,
        menuCategories: categories.count,
        menuItems: menu.count,
        recipes: recipes.count,
        tables: tables.count,
        ...(cleanup ? { cleanup } : {}),
      };
    },
    { timeout: 20000 },
  );
}
