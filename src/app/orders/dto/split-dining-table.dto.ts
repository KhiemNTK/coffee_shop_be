import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

const SplitItemSchema = z.object({
  orderItemId: z.string().uuid({ message: 'orderItemId must be a valid UUID' }),

  quantityToMove: z
    .number()
    .int()
    .positive({ message: 'Quantity must be positive' }),

  // Quantity of the item in the original table
  expectedOriginalQuantity: z.number().int().positive({
    message: 'Must provide the original quantity',
  }),
});

export const SplitOrderSessionSchema = z
  .object({
    sourceOrderSessionId: z.uuid({
      message: 'sourceOrderSessionId must be a valid UUID',
    }),

    destinationTableId: z.uuid({
      message: 'destinationTableId must be a valid UUID',
    }),

    itemsToMove: z
      .array(SplitItemSchema)
      .min(1, { message: 'Must specify at least one item to split' })
      .max(100, { message: 'Cannot split more than 100 items at once' }),
  })
  .refine(
    (data) =>
      new Set(data.itemsToMove.map((item) => item.orderItemId)).size ===
      data.itemsToMove.length,
    {
      message: 'Duplicate order items are not allowed',
      path: ['itemsToMove'],
    },
  );

export class SplitOrderSessionDto extends createZodDto(
  SplitOrderSessionSchema,
) {}
