import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

const OrderItemPayloadSchema = z.object({
  menuItemId: z.uuid({ message: 'Menu item ID must be a valid UUID' }),
  quantity: z
    .number()
    .int()
    .positive({ message: 'Quantity must be at least 1' }),
  note: z.string().max(255, { message: 'Note is too long' }).optional(),
  optionIds: z
    .array(z.uuid())
    .max(20)
    .refine(
      (ids) => new Set(ids).size === ids.length,
      'Duplicate menu options are not allowed',
    )
    .optional(),
});

export const AddOrderItemsSchema = z.object({
  items: z
    .array(OrderItemPayloadSchema)
    .min(1, { message: 'Must add at least one item to the order' })
    .max(100, { message: 'Cannot add more than 100 items at once' }),
});

export class AddOrderItemsDto extends createZodDto(AddOrderItemsSchema) {}
