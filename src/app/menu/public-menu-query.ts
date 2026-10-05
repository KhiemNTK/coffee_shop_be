import { Prisma } from '@prisma/client';

export const PUBLIC_MENU_WHERE = {
  deletedAt: null,
  isAvailable: true,
  category: { deletedAt: null },
  OR: [
    { kitchenStationId: null },
    { kitchenStation: { is: { isActive: true, deletedAt: null } } },
  ],
} satisfies Prisma.MenuItemWhereInput;

export const PUBLIC_MENU_SELECT = {
  id: true,
  name: true,
  price: true,
  category: { select: { id: true, name: true } },
  optionGroups: {
    orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
    select: {
      id: true,
      name: true,
      minSelected: true,
      maxSelected: true,
      options: {
        orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
        select: { id: true, name: true, priceDelta: true },
      },
    },
  },
} satisfies Prisma.MenuItemSelect;
