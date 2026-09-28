import { randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/client';
import {
  resolveMenuSelection,
  type OrderMenuItem,
} from './menu-option-selection';

describe('resolveMenuSelection', () => {
  const inventoryItemId = randomUUID();
  const optionId = randomUUID();
  const extraItemId = randomUUID();
  const item: OrderMenuItem = {
    id: randomUUID(),
    name: 'Coffee',
    price: new Prisma.Decimal(30000),
    kitchenStation: null,
    ingredients: [
      {
        inventoryItemId,
        quantity: new Prisma.Decimal('0.1000'),
        inventoryItem: { deletedAt: null },
      },
    ],
    optionGroups: [
      {
        id: randomUUID(),
        name: 'Size',
        minSelected: 1,
        maxSelected: 1,
        options: [
          {
            id: optionId,
            name: 'Large',
            priceDelta: new Prisma.Decimal(5000),
            ingredients: [
              {
                inventoryItemId,
                quantity: new Prisma.Decimal('0.0500'),
                inventoryItem: { deletedAt: null },
              },
              {
                inventoryItemId: extraItemId,
                quantity: new Prisma.Decimal('0.0200'),
                inventoryItem: { deletedAt: null },
              },
            ],
          },
        ],
      },
    ],
  };

  it('adds option price and combines repeated recipe ingredients', () => {
    const result = resolveMenuSelection(item, [optionId]);
    expect(result.unitPrice.equals(35000)).toBe(true);
    expect(result.selectedOptions).toEqual([
      {
        id: optionId,
        groupName: 'Size',
        name: 'Large',
        priceDelta: '5000',
      },
    ]);
    expect(
      new Map(
        result.recipe.map((ingredient) => [
          ingredient.inventoryItemId,
          ingredient.quantityPerItem.toString(),
        ]),
      ),
    ).toEqual(
      new Map([
        [inventoryItemId, '0.15'],
        [extraItemId, '0.02'],
      ]),
    );
  });

  it('rejects missing, duplicate, foreign and inactive selections', () => {
    expect(() => resolveMenuSelection(item, [])).toThrow('Invalid selection');
    expect(() => resolveMenuSelection(item, [optionId, optionId])).toThrow(
      'Invalid menu option',
    );
    expect(() => resolveMenuSelection(item, [randomUUID()])).toThrow(
      'Invalid selection',
    );
    const inactive = {
      ...item,
      ingredients: item.ingredients.map((ingredient) => ({
        ...ingredient,
        inventoryItem: { deletedAt: new Date() },
      })),
    };
    expect(() => resolveMenuSelection(inactive, [optionId])).toThrow(
      'inactive ingredient',
    );
  });
});
