import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import {
  MenuMoneyInputSchema,
  MenuQuantityInputSchema,
} from './menu-common.dto';

const OptionIngredientSchema = z.object({
  inventoryItemId: z.uuid(),
  quantity: MenuQuantityInputSchema,
});

const OptionSchema = z
  .object({
    name: z.string().trim().min(1).max(80),
    priceDelta: MenuMoneyInputSchema,
    ingredients: z.array(OptionIngredientSchema).max(10).default([]),
  })
  .superRefine(({ ingredients }, context) => {
    const seen = new Set<string>();
    ingredients.forEach(({ inventoryItemId }, index) => {
      if (seen.has(inventoryItemId)) {
        context.addIssue({
          code: 'custom',
          message: 'Duplicate inventory item',
          path: ['ingredients', index],
        });
      }
      seen.add(inventoryItemId);
    });
  });

const OptionGroupSchema = z
  .object({
    name: z.string().trim().min(1).max(80),
    minSelected: z.number().int().min(0).max(20),
    maxSelected: z.number().int().min(1).max(20),
    options: z.array(OptionSchema).min(1).max(10),
  })
  .superRefine(({ minSelected, maxSelected, options }, context) => {
    if (minSelected > maxSelected || maxSelected > options.length) {
      context.addIssue({
        code: 'custom',
        message: 'Invalid selection limits',
        path: ['maxSelected'],
      });
    }
    const names = new Set<string>();
    options.forEach(({ name }, index) => {
      const key = name.toLowerCase();
      if (names.has(key)) {
        context.addIssue({
          code: 'custom',
          message: 'Duplicate option name',
          path: ['options', index, 'name'],
        });
      }
      names.add(key);
    });
  });

export class ReplaceMenuOptionsDto extends createZodDto(
  z
    .object({ groups: z.array(OptionGroupSchema).max(5) })
    .superRefine(({ groups }, context) => {
      if (groups.reduce((total, group) => total + group.minSelected, 0) > 20) {
        context.addIssue({
          code: 'custom',
          message: 'Too many required options',
          path: ['groups'],
        });
      }
      const names = new Set<string>();
      groups.forEach(({ name }, index) => {
        const key = name.toLowerCase();
        if (names.has(key)) {
          context.addIssue({
            code: 'custom',
            message: 'Duplicate group name',
            path: ['groups', index, 'name'],
          });
        }
        names.add(key);
      });
    }),
) {}
