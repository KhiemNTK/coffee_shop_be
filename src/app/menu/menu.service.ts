import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { Prisma, ServeStatus, SessionStatus } from '@prisma/client';
import {
  PRISMA_SERVICE_TOKEN,
  type ExtendedPrismaClient,
} from '../../common/prisma/prisma.service';
import type { ExtendedPrismaTransactionClient } from '../../common/types';
import { PaginationUtilService } from '../../common/utils/pagination-util/pagination-util.service';
import {
  CreateMenuCategoryDto,
  CreateMenuItemDto,
  GetMenuCategoriesDto,
  GetMenuItemsDto,
  ReplaceMenuRecipeDto,
  UpdateMenuCategoryDto,
  UpdateMenuItemAvailabilityDto,
  UpdateMenuItemDto,
} from './dto';

@Injectable()
export class MenuService {
  private readonly logger = new Logger(MenuService.name);
  private readonly maxTransactionRetries = 3;

  constructor(
    @Inject(PRISMA_SERVICE_TOKEN)
    private readonly prisma: ExtendedPrismaClient,
    private readonly paginationUtil: PaginationUtilService,
  ) {}

  async createCategory(employeeId: string, dto: CreateMenuCategoryDto) {
    return this.runSerializable(async (tx) => {
      await this.assertActiveEmployee(tx, employeeId);

      const category = await tx.menuCategory.create({
        data: dto,
      });

      await this.logAction(tx, employeeId, 'MENU_CATEGORY_CREATED', {
        categoryId: category.id,
        name: category.name,
      });
      return category;
    });
  }

  async getCategories(query: GetMenuCategoriesDto) {
    const where: Prisma.MenuCategoryWhereInput = {
      deletedAt: null,
      ...(query.keyword
        ? {
            OR: [
              {
                name: {
                  contains: query.keyword,
                  mode: Prisma.QueryMode.insensitive,
                },
              },
              {
                description: {
                  contains: query.keyword,
                  mode: Prisma.QueryMode.insensitive,
                },
              },
            ],
          }
        : {}),
    };
    const totalItems = await this.prisma.menuCategory.count({ where });
    const paging = this.paginationUtil.paging({
      ...query,
      totalItems,
    });
    const list = await this.prisma.menuCategory.findMany({
      where,
      skip: paging.skip,
      take: paging.itemPerPage,
      orderBy: [{ name: 'asc' }, { id: 'asc' }],
      include: {
        _count: {
          select: {
            menuItems: { where: { deletedAt: null } },
          },
        },
      },
    });

    return paging.format(list);
  }

  async getCategoryById(id: string) {
    const category = await this.prisma.menuCategory.findFirst({
      where: { id, deletedAt: null },
      include: {
        _count: {
          select: {
            menuItems: { where: { deletedAt: null } },
          },
        },
      },
    });

    if (!category) {
      throw new NotFoundException(`Menu category with ID ${id} not found.`);
    }
    return category;
  }

  async updateCategory(
    id: string,
    employeeId: string,
    dto: UpdateMenuCategoryDto,
  ) {
    return this.runSerializable(async (tx) => {
      await this.assertActiveEmployee(tx, employeeId);
      await this.findActiveCategory(tx, id);

      const category = await tx.menuCategory.update({
        where: { id },
        data: dto,
      });
      await this.logAction(tx, employeeId, 'MENU_CATEGORY_UPDATED', {
        categoryId: id,
        changes: {
          ...(dto.name !== undefined ? { name: dto.name } : {}),
          ...(dto.description !== undefined
            ? { description: dto.description }
            : {}),
        },
      });
      return category;
    });
  }

  async deleteCategory(id: string, employeeId: string) {
    await this.runSerializable(async (tx) => {
      await this.assertActiveEmployee(tx, employeeId);
      await this.findActiveCategory(tx, id);

      const activeItemCount = await tx.menuItem.count({
        where: { categoryId: id, deletedAt: null },
      });
      if (activeItemCount > 0) {
        throw new ConflictException(
          'Cannot delete a menu category while active menu items reference it.',
        );
      }

      await tx.menuCategory.update({
        where: { id },
        data: { deletedAt: new Date() },
      });
      await this.logAction(tx, employeeId, 'MENU_CATEGORY_DELETED', {
        categoryId: id,
      });
    });

    return {
      success: true,
      message: `Menu category #${id} has been deleted successfully`,
    };
  }

  async createItem(employeeId: string, dto: CreateMenuItemDto) {
    return this.runSerializable(async (tx) => {
      await this.assertActiveEmployee(tx, employeeId);
      await this.findActiveCategory(tx, dto.categoryId);
      if (dto.kitchenStationId) {
        await this.findActiveKitchenStation(tx, dto.kitchenStationId);
      }

      const item = await tx.menuItem.create({
        data: {
          name: dto.name,
          price: this.toPrice(dto.price),
          categoryId: dto.categoryId,
          kitchenStationId: dto.kitchenStationId,
        },
        include: this.itemInclude,
      });

      await this.logAction(tx, employeeId, 'MENU_ITEM_CREATED', {
        menuItemId: item.id,
        name: item.name,
        price: item.price.toString(),
        categoryId: item.categoryId,
        kitchenStationId: item.kitchenStationId,
      });
      return item;
    });
  }

  async getItems(query: GetMenuItemsDto) {
    const where: Prisma.MenuItemWhereInput = {
      deletedAt: null,
      category: { deletedAt: null },
      ...(query.categoryId ? { categoryId: query.categoryId } : {}),
      ...(query.isAvailable !== undefined
        ? { isAvailable: query.isAvailable }
        : {}),
      ...(query.keyword
        ? {
            name: {
              contains: query.keyword,
              mode: Prisma.QueryMode.insensitive,
            },
          }
        : {}),
    };
    const totalItems = await this.prisma.menuItem.count({ where });
    const paging = this.paginationUtil.paging({
      ...query,
      totalItems,
    });
    const list = await this.prisma.menuItem.findMany({
      where,
      skip: paging.skip,
      take: paging.itemPerPage,
      orderBy: [{ name: 'asc' }, { id: 'asc' }],
      include: this.itemInclude,
    });

    return paging.format(list);
  }

  getPublicCategories() {
    return this.prisma.menuCategory.findMany({
      where: {
        deletedAt: null,
        menuItems: { some: { deletedAt: null, isAvailable: true } },
      },
      select: { id: true, name: true },
      orderBy: [{ name: 'asc' }, { id: 'asc' }],
    });
  }

  async getPublicItems(query: GetMenuItemsDto) {
    const where: Prisma.MenuItemWhereInput = {
      deletedAt: null,
      isAvailable: true,
      category: { deletedAt: null },
      ...(query.categoryId ? { categoryId: query.categoryId } : {}),
      ...(query.keyword
        ? {
            name: {
              contains: query.keyword,
              mode: Prisma.QueryMode.insensitive,
            },
          }
        : {}),
    };
    const totalItems = await this.prisma.menuItem.count({ where });
    const paging = this.paginationUtil.paging({ ...query, totalItems });
    const list = await this.prisma.menuItem.findMany({
      where,
      skip: paging.skip,
      take: paging.itemPerPage,
      orderBy: [{ name: 'asc' }, { id: 'asc' }],
      select: {
        id: true,
        name: true,
        price: true,
        category: { select: { id: true, name: true } },
      },
    });
    return paging.format(list);
  }

  async getItemStockStatus(query: GetMenuItemsDto) {
    const where: Prisma.MenuItemWhereInput = {
      deletedAt: null,
      category: { deletedAt: null },
      ...(query.categoryId ? { categoryId: query.categoryId } : {}),
      ...(query.isAvailable !== undefined
        ? { isAvailable: query.isAvailable }
        : {}),
      ...(query.keyword
        ? {
            name: {
              contains: query.keyword,
              mode: Prisma.QueryMode.insensitive,
            },
          }
        : {}),
    };
    const totalItems = await this.prisma.menuItem.count({ where });
    const paging = this.paginationUtil.paging({ ...query, totalItems });
    const items = await this.prisma.menuItem.findMany({
      where,
      skip: paging.skip,
      take: paging.itemPerPage,
      orderBy: [{ name: 'asc' }, { id: 'asc' }],
      select: {
        id: true,
        name: true,
        isAvailable: true,
        ingredients: {
          select: {
            quantity: true,
            inventoryItem: {
              select: {
                id: true,
                name: true,
                stock: true,
                reorderPoint: true,
                deletedAt: true,
              },
            },
          },
        },
      },
    });

    return paging.format(
      items.map((item) => {
        const insufficient = item.ingredients.filter(
          ({ quantity, inventoryItem }) =>
            inventoryItem.deletedAt || inventoryItem.stock.lt(quantity),
        );
        const low = item.ingredients.filter(
          ({ inventoryItem }) =>
            !inventoryItem.deletedAt &&
            inventoryItem.stock.lte(inventoryItem.reorderPoint),
        );
        return {
          id: item.id,
          name: item.name,
          isAvailable: item.isAvailable,
          stockStatus:
            item.ingredients.length === 0
              ? 'UNTRACKED'
              : insufficient.length > 0
                ? 'INSUFFICIENT'
                : low.length > 0
                  ? 'LOW'
                  : 'OK',
          atRiskIngredients: (insufficient.length > 0 ? insufficient : low).map(
            ({ inventoryItem }) => ({
              id: inventoryItem.id,
              name: inventoryItem.name,
            }),
          ),
        };
      }),
    );
  }

  async getItemById(id: string) {
    const item = await this.prisma.menuItem.findFirst({
      where: { id, deletedAt: null, category: { deletedAt: null } },
      include: this.itemInclude,
    });

    if (!item) {
      throw new NotFoundException(`Menu item with ID ${id} not found.`);
    }
    return item;
  }

  async updateItem(id: string, employeeId: string, dto: UpdateMenuItemDto) {
    return this.runSerializable(async (tx) => {
      await this.assertActiveEmployee(tx, employeeId);
      await this.findActiveItem(tx, id);

      if (dto.categoryId) {
        await this.findActiveCategory(tx, dto.categoryId);
      }
      if (dto.kitchenStationId) {
        await this.findActiveKitchenStation(tx, dto.kitchenStationId);
      }

      const item = await tx.menuItem.update({
        where: { id },
        data: {
          name: dto.name,
          categoryId: dto.categoryId,
          kitchenStationId: dto.kitchenStationId,
          price: dto.price === undefined ? undefined : this.toPrice(dto.price),
        },
        include: this.itemInclude,
      });
      await this.logAction(tx, employeeId, 'MENU_ITEM_UPDATED', {
        menuItemId: id,
        changes: {
          ...(dto.name !== undefined ? { name: dto.name } : {}),
          ...(dto.categoryId !== undefined
            ? { categoryId: dto.categoryId }
            : {}),
          ...(dto.price !== undefined ? { price: item.price.toString() } : {}),
          ...(dto.kitchenStationId !== undefined
            ? { kitchenStationId: dto.kitchenStationId }
            : {}),
        },
      });
      return item;
    });
  }

  async updateItemAvailability(
    id: string,
    employeeId: string,
    dto: UpdateMenuItemAvailabilityDto,
  ) {
    return this.runSerializable(async (tx) => {
      await this.assertActiveEmployee(tx, employeeId);
      const existing = await this.findActiveItem(tx, id);

      if (existing.isAvailable === dto.isAvailable) {
        return existing;
      }

      const item = await tx.menuItem.update({
        where: { id },
        data: { isAvailable: dto.isAvailable },
        include: this.itemInclude,
      });
      await this.logAction(tx, employeeId, 'MENU_ITEM_AVAILABILITY_UPDATED', {
        menuItemId: id,
        before: existing.isAvailable,
        after: item.isAvailable,
      });
      return item;
    });
  }

  async getItemRecipe(id: string) {
    const item = await this.prisma.menuItem.findFirst({
      where: { id, deletedAt: null, category: { deletedAt: null } },
      select: {
        id: true,
        name: true,
        ingredients: {
          where: { inventoryItem: { deletedAt: null } },
          orderBy: { inventoryItemId: 'asc' },
          select: this.recipeIngredientSelect,
        },
      },
    });

    if (!item) {
      throw new NotFoundException(`Menu item with ID ${id} not found.`);
    }
    return item;
  }

  async replaceItemRecipe(
    id: string,
    employeeId: string,
    dto: ReplaceMenuRecipeDto,
  ) {
    return this.runSerializable(async (tx) => {
      await this.assertActiveEmployee(tx, employeeId);
      const item = await this.findActiveItem(tx, id);
      const ingredientIds = dto.ingredients.map(
        (ingredient) => ingredient.inventoryItemId,
      );

      if (new Set(ingredientIds).size !== ingredientIds.length) {
        throw new ConflictException(
          'Duplicate inventory items are not allowed in a recipe.',
        );
      }

      const inventoryItems = await tx.inventoryItem.findMany({
        where: { id: { in: ingredientIds }, deletedAt: null },
        select: { id: true },
      });
      if (inventoryItems.length !== ingredientIds.length) {
        throw new NotFoundException(
          'One or more inventory items were not found or are inactive.',
        );
      }

      const nextIngredients = dto.ingredients
        .map((ingredient) => ({
          inventoryItemId: ingredient.inventoryItemId,
          quantity: this.toQuantity(ingredient.quantity),
        }))
        .sort((a, b) => a.inventoryItemId.localeCompare(b.inventoryItemId));
      const currentIngredients = await tx.menuItemIngredient.findMany({
        where: { menuItemId: id },
        orderBy: { inventoryItemId: 'asc' },
        select: { inventoryItemId: true, quantity: true },
      });

      const isUnchanged =
        currentIngredients.length === nextIngredients.length &&
        currentIngredients.every(
          (ingredient, index) =>
            ingredient.inventoryItemId ===
              nextIngredients[index].inventoryItemId &&
            ingredient.quantity.equals(nextIngredients[index].quantity),
        );

      if (!isUnchanged) {
        await tx.menuItemIngredient.deleteMany({
          where: { menuItemId: id },
        });
        if (nextIngredients.length > 0) {
          await tx.menuItemIngredient.createMany({
            data: nextIngredients.map((ingredient) => ({
              menuItemId: id,
              ...ingredient,
            })),
          });
        }

        await this.logAction(tx, employeeId, 'MENU_RECIPE_REPLACED', {
          menuItemId: id,
          before: currentIngredients.map((ingredient) => ({
            inventoryItemId: ingredient.inventoryItemId,
            quantity: ingredient.quantity.toString(),
          })),
          after: nextIngredients.map((ingredient) => ({
            inventoryItemId: ingredient.inventoryItemId,
            quantity: ingredient.quantity.toString(),
          })),
        });
      }

      const ingredients = await tx.menuItemIngredient.findMany({
        where: {
          menuItemId: id,
          inventoryItem: { deletedAt: null },
        },
        orderBy: { inventoryItemId: 'asc' },
        select: this.recipeIngredientSelect,
      });

      return { id: item.id, name: item.name, ingredients };
    });
  }

  async deleteItem(id: string, employeeId: string) {
    await this.runSerializable(async (tx) => {
      await this.assertActiveEmployee(tx, employeeId);
      await this.findActiveItem(tx, id);

      const activeOrderItemCount = await tx.orderItem.count({
        where: {
          menuItemId: id,
          serveStatus: { in: [ServeStatus.PENDING, ServeStatus.COOKING] },
          orderSession: { sessionStatus: SessionStatus.ACTIVE },
        },
      });
      if (activeOrderItemCount > 0) {
        throw new ConflictException(
          'Cannot delete a menu item while it has pending or cooking orders. Mark it unavailable instead.',
        );
      }

      const recipe = await tx.menuItemIngredient.findMany({
        where: { menuItemId: id },
        select: { inventoryItemId: true, quantity: true },
      });

      await tx.menuItem.update({
        where: { id },
        data: { deletedAt: new Date(), isAvailable: false },
      });
      await tx.menuItemIngredient.deleteMany({
        where: { menuItemId: id },
      });
      await this.logAction(tx, employeeId, 'MENU_ITEM_DELETED', {
        menuItemId: id,
        removedRecipe: recipe.map((ingredient) => ({
          inventoryItemId: ingredient.inventoryItemId,
          quantity: ingredient.quantity.toString(),
        })),
      });
    });

    return {
      success: true,
      message: `Menu item #${id} has been deleted successfully`,
    };
  }

  private readonly itemInclude = {
    category: { select: { id: true, name: true } },
    kitchenStation: { select: { id: true, code: true, name: true } },
  } as const;

  private readonly recipeIngredientSelect = {
    inventoryItemId: true,
    quantity: true,
    inventoryItem: {
      select: {
        id: true,
        name: true,
        stock: true,
        unit: { select: { id: true, name: true } },
        category: { select: { id: true, name: true } },
      },
    },
  } as const;

  private async findActiveCategory(
    tx: ExtendedPrismaTransactionClient,
    id: string,
  ) {
    const category = await tx.menuCategory.findFirst({
      where: { id, deletedAt: null },
    });
    if (!category) {
      throw new NotFoundException(`Menu category with ID ${id} not found.`);
    }
    return category;
  }

  private async findActiveItem(
    tx: ExtendedPrismaTransactionClient,
    id: string,
  ) {
    const item = await tx.menuItem.findFirst({
      where: { id, deletedAt: null, category: { deletedAt: null } },
      include: this.itemInclude,
    });
    if (!item) {
      throw new NotFoundException(`Menu item with ID ${id} not found.`);
    }
    return item;
  }

  private async findActiveKitchenStation(
    tx: ExtendedPrismaTransactionClient,
    id: string,
  ) {
    const station = await tx.kitchenStation.findFirst({
      where: { id, isActive: true, deletedAt: null },
      select: { id: true },
    });
    if (!station) {
      throw new NotFoundException(
        `Active kitchen station with ID ${id} not found.`,
      );
    }
  }

  private async assertActiveEmployee(
    tx: ExtendedPrismaTransactionClient,
    employeeId: string,
  ) {
    const employee = await tx.employee.findFirst({
      where: { id: employeeId, isActive: true, deletedAt: null },
      select: { id: true },
    });
    if (!employee) {
      throw new UnauthorizedException('Employee is inactive or not found.');
    }
  }

  private toPrice(value: string | number) {
    const price = new Prisma.Decimal(value);
    if (!price.isFinite() || price.isNegative() || price.decimalPlaces() > 2) {
      throw new BadRequestException(
        'Price must be a non-negative decimal with at most 2 decimal places.',
      );
    }
    return price;
  }

  private toQuantity(value: string | number) {
    const quantity = new Prisma.Decimal(value);
    if (
      !quantity.isFinite() ||
      !quantity.isPositive() ||
      quantity.decimalPlaces() > 4
    ) {
      throw new BadRequestException(
        'Quantity must be greater than 0 with at most 4 decimal places.',
      );
    }
    return quantity;
  }

  private async logAction(
    tx: ExtendedPrismaTransactionClient,
    employeeId: string,
    actionType: string,
    details: Prisma.InputJsonObject,
  ) {
    await tx.actionLog.create({
      data: { employeeId, actionType, details },
    });
  }

  private async runSerializable<T>(
    callback: (tx: ExtendedPrismaTransactionClient) => Promise<T>,
  ): Promise<T> {
    for (let attempt = 1; attempt <= this.maxTransactionRetries; attempt++) {
      try {
        return await this.prisma.$transaction(callback, {
          isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
        });
      } catch (error) {
        if (
          this.isSerializationConflict(error) &&
          attempt < this.maxTransactionRetries
        ) {
          this.logger.warn(
            `Menu transaction conflict. Retrying attempt ${attempt + 1}/${this.maxTransactionRetries}`,
          );
          await new Promise((resolve) => setTimeout(resolve, attempt * 25));
          continue;
        }
        throw error;
      }
    }

    throw new ConflictException('Menu transaction failed. Please try again.');
  }

  private isSerializationConflict(error: unknown) {
    return (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === 'P2034'
    );
  }
}
