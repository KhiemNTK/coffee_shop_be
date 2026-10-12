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
  description: z.string().trim().max(1000).nullable().optional(),
  imageUrl: z
    .url()
    .max(2048)
    .refine((value) => {
      const url = new URL(value);
      return url.protocol === 'https:' && !url.username && !url.password;
    }, 'Menu images require an HTTPS URL without credentials')
    .nullable()
    .optional(),
  price: MenuMoneyInputSchema,
  categoryId: z.uuid('Invalid UUID for menu category'),
  kitchenStationId: z
    .uuid('Invalid UUID for kitchen station')
    .nullable()
    .optional(),
};

export class CreateMenuItemDto extends createZodDto(
  z.object(MenuItemInputSchema),
) {}

export class UpdateMenuItemDto extends createZodDto(
  NonEmptyUpdateSchema({
    name: MenuItemInputSchema.name.optional(),
    description: MenuItemInputSchema.description,
    imageUrl: MenuItemInputSchema.imageUrl,
    price: MenuItemInputSchema.price.optional(),
    categoryId: MenuItemInputSchema.categoryId.optional(),
    kitchenStationId: MenuItemInputSchema.kitchenStationId,
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
