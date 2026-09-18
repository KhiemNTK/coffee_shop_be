import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { MenuQuantityInputSchema } from './menu-common.dto';

const MenuRecipeIngredientSchema = z.object({
  inventoryItemId: z.uuid('Invalid UUID for inventory item'),
  quantity: MenuQuantityInputSchema,
});

export class ReplaceMenuRecipeDto extends createZodDto(
  z
    .object({
      ingredients: z.array(MenuRecipeIngredientSchema).max(100),
    })
    .superRefine(({ ingredients }, context) => {
      const seenIds = new Set<string>();

      ingredients.forEach((ingredient, index) => {
        if (seenIds.has(ingredient.inventoryItemId)) {
          context.addIssue({
            code: 'custom',
            message: 'Duplicate inventory items are not allowed',
            path: ['ingredients', index, 'inventoryItemId'],
          });
        }
        seenIds.add(ingredient.inventoryItemId);
      });
    }),
) {}
