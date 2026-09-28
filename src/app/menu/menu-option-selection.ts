import { ConflictException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { z } from 'zod';

export const ORDER_MENU_ITEM_SELECT = {
  id: true,
  name: true,
  price: true,
  ingredients: {
    select: {
      inventoryItemId: true,
      quantity: true,
      inventoryItem: { select: { deletedAt: true } },
    },
  },
  optionGroups: {
    orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
    select: {
      id: true,
      name: true,
      minSelected: true,
      maxSelected: true,
      options: {
        orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
        select: {
          id: true,
          name: true,
          priceDelta: true,
          ingredients: {
            select: {
              inventoryItemId: true,
              quantity: true,
              inventoryItem: { select: { deletedAt: true } },
            },
          },
        },
      },
    },
  },
  kitchenStation: {
    select: {
      id: true,
      code: true,
      name: true,
      prepSlaSeconds: true,
      printDevice: {
        select: { id: true, isActive: true, deletedAt: true },
      },
    },
  },
} satisfies Prisma.MenuItemSelect;

export type OrderMenuItem = Prisma.MenuItemGetPayload<{
  select: typeof ORDER_MENU_ITEM_SELECT;
}>;

const optionSnapshotSchema = z
  .array(
    z.object({
      id: z.uuid(),
      groupName: z.string(),
      name: z.string(),
      priceDelta: z.string(),
    }),
  )
  .max(20);

export type SelectedMenuOption = z.infer<typeof optionSnapshotSchema>[number];

export function readSelectedOptions(value: unknown): SelectedMenuOption[] {
  const parsed = optionSnapshotSchema.safeParse(value);
  if (!parsed.success) {
    throw new ConflictException('Saved menu options are invalid.');
  }
  return parsed.data;
}

export function resolveMenuSelection(
  menuItem: OrderMenuItem,
  optionIds: string[] = [],
) {
  if (optionIds.length > 20 || new Set(optionIds).size !== optionIds.length) {
    throw new ConflictException('Invalid menu option selection.');
  }

  const selectedIds = new Set(optionIds);
  const selectedOptions: SelectedMenuOption[] = [];
  const recipe = new Map<string, Prisma.Decimal>();
  let unitPrice = menuItem.price;

  const addIngredient = (ingredient: {
    inventoryItemId: string;
    quantity: Prisma.Decimal;
    inventoryItem: { deletedAt: Date | null };
  }) => {
    if (ingredient.inventoryItem.deletedAt) {
      throw new ConflictException(
        'The menu recipe contains an inactive ingredient.',
      );
    }
    recipe.set(
      ingredient.inventoryItemId,
      (recipe.get(ingredient.inventoryItemId) ?? new Prisma.Decimal(0)).plus(
        ingredient.quantity,
      ),
    );
  };

  menuItem.ingredients.forEach(addIngredient);
  for (const group of menuItem.optionGroups) {
    const selected = group.options.filter((option) =>
      selectedIds.has(option.id),
    );
    if (
      selected.length < group.minSelected ||
      selected.length > group.maxSelected
    ) {
      throw new ConflictException(
        `Invalid selection for menu option group '${group.name}'.`,
      );
    }
    for (const option of selected) {
      selectedIds.delete(option.id);
      unitPrice = unitPrice.plus(option.priceDelta);
      selectedOptions.push({
        id: option.id,
        groupName: group.name,
        name: option.name,
        priceDelta: option.priceDelta.toString(),
      });
      option.ingredients.forEach(addIngredient);
    }
  }

  if (selectedIds.size > 0) {
    throw new ConflictException('One or more menu options are unavailable.');
  }
  if (unitPrice.gt('9999999999999999.99')) {
    throw new ConflictException(
      'Selected menu options exceed the allowed price.',
    );
  }
  return {
    unitPrice,
    selectedOptions,
    recipe: [...recipe]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([inventoryItemId, quantityPerItem]) => ({
        inventoryItemId,
        quantityPerItem,
      })),
  };
}
