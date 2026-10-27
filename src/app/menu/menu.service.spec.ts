import { ConflictException, Logger, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PaginationUtilService } from '../../common/utils/pagination-util/pagination-util.service';
import { MenuService } from './menu.service';
import {
  GetPublicMenuItemsDto,
  ReplaceMenuOptionsDto,
  ReplaceMenuRecipeDto,
} from './dto';
import type { MenuImagesService } from './menu-images.service';

describe('MenuService', () => {
  let service: MenuService;
  let prisma: any;
  let tx: any;
  let images: { syncReference: jest.Mock };

  const activeItem = {
    id: 'menu-item-id',
    name: 'Espresso',
    categoryId: 'category-id',
    isAvailable: true,
    category: { id: 'category-id', name: 'Coffee' },
  };

  beforeEach(() => {
    tx = {
      employee: {
        findFirst: jest.fn().mockResolvedValue({ id: 'employee-id' }),
      },
      menuCategory: {
        create: jest.fn(),
        findFirst: jest.fn().mockResolvedValue({
          id: 'category-id',
          name: 'Coffee',
        }),
        update: jest.fn(),
      },
      menuItem: {
        create: jest.fn(),
        count: jest.fn(),
        findFirst: jest.fn().mockResolvedValue(activeItem),
        findFirstOrThrow: jest.fn(),
        update: jest.fn(),
      },
      menuItemOptionGroup: { findMany: jest.fn(), deleteMany: jest.fn() },
      menuItemIngredient: {
        createMany: jest.fn(),
        deleteMany: jest.fn(),
        findMany: jest.fn(),
      },
      inventoryItem: { findMany: jest.fn() },
      orderItem: { count: jest.fn() },
      actionLog: { create: jest.fn() },
    };
    prisma = {
      $transaction: jest.fn((callback: (client: any) => unknown) =>
        callback(tx),
      ),
      menuCategory: {
        count: jest.fn(),
        findFirst: jest.fn(),
        findMany: jest.fn(),
      },
      menuItem: {
        count: jest.fn(),
        findFirst: jest.fn(),
        findMany: jest.fn(),
      },
    };
    images = { syncReference: jest.fn() };
    service = new MenuService(
      prisma as never,
      new PaginationUtilService(),
      images as unknown as MenuImagesService,
    );
  });

  afterEach(() => jest.restoreAllMocks());

  async function recipeRevision(
    ingredients: Array<{
      inventoryItemId: string;
      quantity: string | Prisma.Decimal;
    }>,
  ) {
    prisma.menuItem.findFirst.mockResolvedValue({
      ...activeItem,
      ingredients: ingredients.map((ingredient) => ({
        ...ingredient,
        inventoryItem: { deletedAt: null },
      })),
    });
    return (await service.getItemRecipe(activeItem.id)).revision;
  }

  async function optionsRevision(optionGroups: unknown[] = []) {
    prisma.menuItem.findFirst.mockResolvedValue({
      ...activeItem,
      optionGroups,
    });
    return (await service.getItemOptions(activeItem.id)).revision;
  }

  it('requires an observed revision for both configuration writes', () => {
    for (const [schema, payload] of [
      [ReplaceMenuRecipeDto.schema, { ingredients: [] }],
      [ReplaceMenuOptionsDto.schema, { groups: [] }],
    ] as const) {
      expect(schema.safeParse(payload).success).toBe(false);
      expect(
        schema.safeParse({ ...payload, expectedRevision: 'invalid' }).success,
      ).toBe(false);
      expect(
        schema.safeParse({ ...payload, expectedRevision: 'a'.repeat(64) })
          .success,
      ).toBe(true);
    }
  });

  it('normalizes decimal input and ignores stock changes in recipe revisions', async () => {
    const first = await recipeRevision([
      { inventoryItemId: 'inventory-id', quantity: '1.0' },
    ]);
    prisma.menuItem.findFirst.mockResolvedValue({
      ...activeItem,
      ingredients: [
        {
          inventoryItemId: 'inventory-id',
          quantity: new Prisma.Decimal('1.0000'),
          inventoryItem: { deletedAt: null, stock: new Prisma.Decimal('999') },
        },
      ],
    });
    expect((await service.getItemRecipe(activeItem.id)).revision).toBe(first);
  });

  it('attaches a supplied image in the same menu creation transaction', async () => {
    const imageUrl = 'https://images.test/managed-menu/drink.webp';
    tx.menuItem.create.mockResolvedValue({
      ...activeItem,
      price: new Prisma.Decimal(35000),
    });
    await service.createItem('employee-id', {
      name: 'Coffee',
      price: '35000',
      categoryId: 'category-id',
      imageUrl,
    });
    expect(images.syncReference).toHaveBeenCalledWith(
      tx,
      'employee-id',
      activeItem.id,
      imageUrl,
    );
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
  });

  it('does not touch image references for unrelated menu edits', async () => {
    tx.menuItem.update.mockResolvedValue(activeItem);
    await service.updateItem(activeItem.id, 'employee-id', { name: 'Renamed' });
    expect(images.syncReference).not.toHaveBeenCalled();
    await service.updateItem(activeItem.id, 'employee-id', { imageUrl: null });
    expect(images.syncReference).toHaveBeenCalledWith(
      tx,
      'employee-id',
      activeItem.id,
      null,
    );
  });

  it('returns the full option editor contract without rewriting unchanged options', async () => {
    tx.inventoryItem.findMany.mockResolvedValue([]);
    tx.menuItemOptionGroup.findMany.mockResolvedValue([]);
    tx.menuItem.findFirstOrThrow.mockResolvedValue({
      id: activeItem.id,
      name: activeItem.name,
      optionGroups: [],
    });
    await expect(
      service.replaceItemOptions(activeItem.id, 'employee-id', {
        groups: [],
        expectedRevision: await optionsRevision(),
      }),
    ).resolves.toMatchObject({ name: activeItem.name, optionGroups: [] });
    expect(tx.menuItem.findFirstOrThrow).toHaveBeenCalledWith(
      expect.objectContaining({
        select: expect.objectContaining({ id: true, name: true }),
      }),
    );
    expect(tx.menuItemOptionGroup.deleteMany).not.toHaveBeenCalled();
    expect(tx.actionLog.create).not.toHaveBeenCalled();
  });

  it('blocks deleting a category that still has active menu items', async () => {
    tx.menuItem.count.mockResolvedValue(1);

    await expect(
      service.deleteCategory('category-id', 'employee-id'),
    ).rejects.toBeInstanceOf(ConflictException);

    expect(tx.menuCategory.update).not.toHaveBeenCalled();
    expect(tx.actionLog.create).not.toHaveBeenCalled();
  });

  it('publishes only available items with public fields', async () => {
    prisma.menuItem.count.mockResolvedValue(1);
    prisma.menuItem.findMany.mockResolvedValue([
      { id: 'menu-item-id', name: 'Espresso', price: '30000' },
    ]);

    await service.getPublicItems(GetPublicMenuItemsDto.schema.parse({}));

    expect(prisma.menuItem.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ isAvailable: true, deletedAt: null }),
        orderBy: [{ name: 'asc' }, { id: 'asc' }],
        select: expect.objectContaining({
          id: true,
          name: true,
          price: true,
          category: { select: { id: true, name: true } },
          optionGroups: expect.any(Object),
        }),
      }),
    );
  });

  it.each([
    ['name', 'asc'],
    ['name', 'desc'],
    ['price', 'asc'],
    ['price', 'desc'],
  ])(
    'sorts public items by %s %s before pagination with a unique tie-breaker',
    async (sortBy, sortOrder) => {
      prisma.menuItem.count.mockResolvedValue(25);
      prisma.menuItem.findMany.mockResolvedValue([]);
      const query = GetPublicMenuItemsDto.schema.parse({
        page: 2,
        itemPerPage: 12,
        keyword: 'coffee',
        sortBy,
        sortOrder,
      });

      const result = await service.getPublicItems(query);

      expect(prisma.menuItem.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          orderBy: [{ [sortBy]: sortOrder }, { id: 'asc' }],
          skip: 12,
          take: 12,
          where: expect.objectContaining({
            name: { contains: 'coffee', mode: 'insensitive' },
            isAvailable: true,
            deletedAt: null,
          }),
        }),
      );
      expect(result).toMatchObject({
        currentPage: 2,
        totalItems: 25,
        totalPages: 3,
      });
    },
  );

  it('reports recipe stock risk without reserving or changing stock', async () => {
    prisma.menuItem.count.mockResolvedValue(1);
    prisma.menuItem.findMany.mockResolvedValue([
      {
        id: 'menu-item-id',
        name: 'Espresso',
        isAvailable: true,
        ingredients: [
          {
            quantity: new Prisma.Decimal('2'),
            inventoryItem: {
              id: 'inventory-id',
              name: 'Coffee beans',
              stock: new Prisma.Decimal('1'),
              reorderPoint: new Prisma.Decimal('5'),
              deletedAt: null,
            },
          },
        ],
      },
    ]);

    const result = await service.getItemStockStatus({
      page: 1,
      itemPerPage: 20,
    });

    expect(result.list[0]).toEqual({
      id: 'menu-item-id',
      name: 'Espresso',
      isAvailable: true,
      stockStatus: 'INSUFFICIENT',
      atRiskIngredients: [{ id: 'inventory-id', name: 'Coffee beans' }],
    });
    expect(result).toMatchObject({
      totalItems: 1,
      totalPages: 1,
      currentPage: 1,
    });
    expect(prisma.menuItem.findMany).toHaveBeenCalledTimes(1);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('distinguishes an untracked recipe from low stock', async () => {
    prisma.menuItem.count.mockResolvedValue(2);
    prisma.menuItem.findMany.mockResolvedValue([
      { id: 'untracked', name: 'Tea', isAvailable: true, ingredients: [] },
      {
        id: 'low',
        name: 'Latte',
        isAvailable: true,
        ingredients: [
          {
            quantity: new Prisma.Decimal('1'),
            inventoryItem: {
              id: 'milk-id',
              name: 'Milk',
              stock: new Prisma.Decimal('5'),
              reorderPoint: new Prisma.Decimal('5'),
              deletedAt: null,
            },
          },
        ],
      },
    ]);

    const result = await service.getItemStockStatus({
      page: 1,
      itemPerPage: 20,
    });

    expect(result.list.map((item) => item.stockStatus)).toEqual([
      'UNTRACKED',
      'LOW',
    ]);
  });

  it('returns the filtered stock count and pagination even on an empty later page', async () => {
    prisma.menuItem.count.mockResolvedValue(21);
    prisma.menuItem.findMany.mockResolvedValue([]);
    await expect(
      service.getItemStockStatus({
        page: 3,
        itemPerPage: 10,
        keyword: 'tea',
        isAvailable: false,
      }),
    ).resolves.toEqual({
      list: [],
      totalItems: 21,
      totalPages: 3,
      currentPage: 3,
    });
    expect(prisma.menuItem.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        skip: 20,
        take: 10,
        where: expect.objectContaining({
          isAvailable: false,
          name: { contains: 'tea', mode: 'insensitive' },
        }),
      }),
    );
  });

  it('rejects replacing a recipe when an inventory item is inactive or missing', async () => {
    tx.inventoryItem.findMany.mockResolvedValue([]);

    await expect(
      service.replaceItemRecipe('menu-item-id', 'employee-id', {
        expectedRevision: 'a'.repeat(64),
        ingredients: [{ inventoryItemId: 'inventory-id', quantity: '1' }],
      }),
    ).rejects.toBeInstanceOf(NotFoundException);

    expect(tx.menuItemIngredient.deleteMany).not.toHaveBeenCalled();
    expect(tx.actionLog.create).not.toHaveBeenCalled();
  });

  it('does not rewrite or audit an unchanged recipe', async () => {
    tx.inventoryItem.findMany.mockResolvedValue([{ id: 'inventory-id' }]);
    tx.menuItemIngredient.findMany
      .mockResolvedValueOnce([
        {
          inventoryItemId: 'inventory-id',
          quantity: new Prisma.Decimal(1),
        },
      ])
      .mockResolvedValueOnce([
        {
          inventoryItemId: 'inventory-id',
          quantity: new Prisma.Decimal(1),
        },
      ]);

    await service.replaceItemRecipe('menu-item-id', 'employee-id', {
      expectedRevision: await recipeRevision([
        { inventoryItemId: 'inventory-id', quantity: '1' },
      ]),
      ingredients: [{ inventoryItemId: 'inventory-id', quantity: '1.0000' }],
    });

    expect(tx.menuItemIngredient.deleteMany).not.toHaveBeenCalled();
    expect(tx.menuItemIngredient.createMany).not.toHaveBeenCalled();
    expect(tx.actionLog.create).not.toHaveBeenCalled();
  });

  it('replaces and audits a changed recipe atomically', async () => {
    tx.inventoryItem.findMany.mockResolvedValue([{ id: 'inventory-id' }]);
    tx.menuItemIngredient.findMany
      .mockResolvedValueOnce([
        {
          inventoryItemId: 'old-inventory-id',
          quantity: new Prisma.Decimal(1),
        },
      ])
      .mockResolvedValueOnce([
        {
          inventoryItemId: 'inventory-id',
          quantity: new Prisma.Decimal('0.25'),
        },
      ]);

    const result = await service.replaceItemRecipe(
      'menu-item-id',
      'employee-id',
      {
        expectedRevision: await recipeRevision([
          { inventoryItemId: 'old-inventory-id', quantity: '1' },
        ]),
        ingredients: [{ inventoryItemId: 'inventory-id', quantity: '0.25' }],
      },
    );

    expect(tx.menuItemIngredient.deleteMany).toHaveBeenCalledWith({
      where: { menuItemId: 'menu-item-id' },
    });
    expect(tx.menuItemIngredient.createMany).toHaveBeenCalledWith({
      data: [
        {
          menuItemId: 'menu-item-id',
          inventoryItemId: 'inventory-id',
          quantity: new Prisma.Decimal('0.25'),
        },
      ],
    });
    expect(tx.actionLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ actionType: 'MENU_RECIPE_REPLACED' }),
      }),
    );
    expect(result.ingredients).toHaveLength(1);
  });

  it('rejects a stale recipe before deleting ingredients or writing an audit', async () => {
    const expectedRevision = await recipeRevision([
      { inventoryItemId: 'inventory-id', quantity: '1' },
    ]);
    tx.inventoryItem.findMany.mockResolvedValue([{ id: 'inventory-id' }]);
    tx.menuItemIngredient.findMany.mockResolvedValue([
      { inventoryItemId: 'inventory-id', quantity: new Prisma.Decimal('2') },
    ]);
    await expect(
      service.replaceItemRecipe(activeItem.id, 'employee-id', {
        expectedRevision,
        ingredients: [{ inventoryItemId: 'inventory-id', quantity: '3' }],
      }),
    ).rejects.toMatchObject({
      response: { code: 'MENU_CONFIGURATION_CHANGED' },
    });
    expect(tx.menuItemIngredient.deleteMany).not.toHaveBeenCalled();
    expect(tx.actionLog.create).not.toHaveBeenCalled();
  });

  it('rejects stale options even if the requested configuration matches the latest one', async () => {
    const expectedRevision = await optionsRevision();
    const groups = [
      {
        name: 'Size',
        minSelected: 0,
        maxSelected: 1,
        options: [{ name: 'Large', priceDelta: '1000', ingredients: [] }],
      },
    ];
    tx.inventoryItem.findMany.mockResolvedValue([]);
    tx.menuItemOptionGroup.findMany.mockResolvedValue(groups);
    await expect(
      service.replaceItemOptions(activeItem.id, 'employee-id', {
        expectedRevision,
        groups,
      }),
    ).rejects.toMatchObject({
      response: { code: 'MENU_CONFIGURATION_CHANGED' },
    });
    expect(tx.menuItemOptionGroup.deleteMany).not.toHaveBeenCalled();
    expect(tx.actionLog.create).not.toHaveBeenCalled();
  });

  it('blocks deleting an item with pending or cooking orders', async () => {
    tx.orderItem.count.mockResolvedValue(1);

    await expect(
      service.deleteItem('menu-item-id', 'employee-id'),
    ).rejects.toBeInstanceOf(ConflictException);

    expect(tx.menuItem.update).not.toHaveBeenCalled();
    expect(tx.menuItemIngredient.deleteMany).not.toHaveBeenCalled();
  });

  it('soft-deletes an item and removes its current recipe in one transaction', async () => {
    tx.orderItem.count.mockResolvedValue(0);
    tx.menuItemIngredient.findMany.mockResolvedValue([
      {
        inventoryItemId: 'inventory-id',
        quantity: new Prisma.Decimal('0.25'),
      },
    ]);

    await service.deleteItem('menu-item-id', 'employee-id');

    expect(images.syncReference).toHaveBeenCalledWith(
      tx,
      'employee-id',
      'menu-item-id',
      null,
    );

    expect(tx.menuItem.update).toHaveBeenCalledWith({
      where: { id: 'menu-item-id' },
      data: { deletedAt: expect.any(Date), isAvailable: false },
    });
    expect(tx.menuItemIngredient.deleteMany).toHaveBeenCalledWith({
      where: { menuItemId: 'menu-item-id' },
    });
    expect(tx.actionLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ actionType: 'MENU_ITEM_DELETED' }),
      }),
    );
  });

  it('retries serialization conflicts', async () => {
    const warning = jest.spyOn(Logger, 'warn').mockImplementation();
    const serializationConflict = new Prisma.PrismaClientKnownRequestError(
      'Serialization conflict',
      { code: 'P2034', clientVersion: 'test' },
    );
    tx.menuCategory.create.mockResolvedValue({
      id: 'category-id',
      name: 'Coffee',
    });
    prisma.$transaction
      .mockRejectedValueOnce(serializationConflict)
      .mockImplementationOnce((callback: (client: any) => unknown) =>
        callback(tx),
      );

    await service.createCategory('employee-id', {
      name: 'Coffee',
    });

    expect(prisma.$transaction).toHaveBeenCalledTimes(2);
    expect(warning).toHaveBeenCalledWith(
      'MenuService conflict. Retrying attempt 2/3',
      'MenuService',
    );
  });
});
