import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { MenuPaginationSchema, NonEmptyUpdateSchema } from './menu-common.dto';

const MenuCategoryInputSchema = {
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(500).nullable().optional(),
};

export class CreateMenuCategoryDto extends createZodDto(
  z.object(MenuCategoryInputSchema),
) {}

export class UpdateMenuCategoryDto extends createZodDto(
  NonEmptyUpdateSchema({
    name: MenuCategoryInputSchema.name.optional(),
    description: MenuCategoryInputSchema.description,
  }),
) {}

export class GetMenuCategoriesDto extends createZodDto(MenuPaginationSchema) {}
