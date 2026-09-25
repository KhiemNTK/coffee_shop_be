import { StocktakeStatus } from '@prisma/client';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import {
  InventoryDecimalInputSchema,
  InventoryPaginationSchema,
  OptionalDateSchema,
  RequiredIdempotencyKeySchema,
} from './inventory-common.dto';

export class CreateStocktakeDto extends createZodDto(
  z.object({
    inventoryItemIds: z
      .array(z.uuid('Invalid UUID for inventory item'))
      .min(1)
      .max(100),
    note: z.string().trim().min(1).max(500).nullish(),
    idempotencyKey: RequiredIdempotencyKeySchema,
  }),
) {}

export class UpdateStocktakeCountsDto extends createZodDto(
  z.object({
    items: z
      .array(
        z.object({
          inventoryItemId: z.uuid('Invalid UUID for inventory item'),
          countedQuantity: InventoryDecimalInputSchema,
        }),
      )
      .min(1)
      .max(100),
  }),
) {}

export class PostStocktakeDto extends createZodDto(
  z.object({ idempotencyKey: RequiredIdempotencyKeySchema }),
) {}

export class CancelStocktakeDto extends createZodDto(
  z.object({ reason: z.string().trim().min(3).max(500) }),
) {}

export class GetStocktakesDto extends createZodDto(
  InventoryPaginationSchema.pick({ itemPerPage: true, page: true })
    .extend({
      status: z.enum(StocktakeStatus).optional(),
      createdFrom: OptionalDateSchema,
      createdTo: OptionalDateSchema,
    })
    .refine(
      ({ createdFrom, createdTo }) =>
        !createdFrom || !createdTo || createdFrom <= createdTo,
      {
        path: ['createdFrom'],
        message: 'createdFrom must be before or equal to createdTo',
      },
    ),
) {}
