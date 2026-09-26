import { ConflictException, Logger, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PaginationUtilService } from '../../common/utils/pagination-util/pagination-util.service';
import { MenuService } from './menu.service';

describe('MenuService', () => {
  let service: MenuService;
  let prisma: any;
  let tx: any;

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
        update: jest.fn(),
      },
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
    service = new MenuService(prisma as never, new PaginationUtilService());
  });

  afterEach(() => jest.restoreAllMocks());

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

    await service.getPublicItems({ page: 1, itemPerPage: 20 });

    expect(prisma.menuItem.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ isAvailable: true, deletedAt: null }),
        select: {
          id: true,
          name: true,
          price: true,
          category: { select: { id: true, name: true } },
        },
      }),
    );
  });

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

  it('rejects replacing a recipe when an inventory item is inactive or missing', async () => {
    tx.inventoryItem.findMany.mockResolvedValue([]);

    await expect(
      service.replaceItemRecipe('menu-item-id', 'employee-id', {
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
