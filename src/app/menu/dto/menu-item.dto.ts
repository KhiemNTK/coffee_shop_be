import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import {
  MenuMoneyInputSchema,
  MenuPaginationSchema,
  NonEmptyUpdateSchema,
  OptionalBooleanQuerySchema,
} from './menu-common.dto';

const MenuItemInputSchema = {
  name: z.string().trim().min(1).max(160),
  price: MenuMoneyInputSchema,
  categoryId: z.uuid('Invalid UUID for menu category'),
};

export class CreateMenuItemDto extends createZodDto(
  z.object(MenuItemInputSchema),
) {}

export class UpdateMenuItemDto extends createZodDto(
  NonEmptyUpdateSchema({
    name: MenuItemInputSchema.name.optional(),
    price: MenuItemInputSchema.price.optional(),
    categoryId: MenuItemInputSchema.categoryId.optional(),
  }),
) {}

export class UpdateMenuItemAvailabilityDto extends createZodDto(
  z.object({ isAvailable: z.boolean() }),
) {}

export class GetMenuItemsDto extends createZodDto(
  MenuPaginationSchema.extend({
    categoryId: z.uuid('Invalid UUID for menu category').optional(),
    isAvailable: OptionalBooleanQuerySchema,
  }),
) {}
