import { PurchaseReceiptStatus } from '@prisma/client';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import {
  InventoryPaginationSchema,
  MoneyInputSchema,
  OptionalDateSchema,
  PositiveInventoryDecimalInputSchema,
  RequiredIdempotencyKeySchema,
} from './inventory-common.dto';

const PurchaseReceiptLineSchema = z.object({
  inventoryItemId: z.uuid('Invalid UUID for inventory item'),
  quantity: PositiveInventoryDecimalInputSchema,
  unitPrice: MoneyInputSchema,
});

const ReceiptFieldsSchema = z.object({
  supplierId: z.uuid('Invalid UUID for supplier'),
  receivedAt: OptionalDateSchema,
  note: z.string().trim().min(1).max(500).nullish(),
  items: z.array(PurchaseReceiptLineSchema).min(1).max(100),
});

export class CreatePurchaseReceiptDto extends createZodDto(
  ReceiptFieldsSchema.extend({
    idempotencyKey: RequiredIdempotencyKeySchema,
  }),
) {}

export class UpdatePurchaseReceiptDto extends createZodDto(
  ReceiptFieldsSchema.partial().refine(
    (value) => Object.keys(value).length > 0,
    'At least one field is required',
  ),
) {}

export class PostPurchaseReceiptDto extends createZodDto(
  z.object({ idempotencyKey: RequiredIdempotencyKeySchema }),
) {}

export class CancelPurchaseReceiptDto extends createZodDto(
  z.object({ reason: z.string().trim().min(3).max(500) }),
) {}

export class GetPurchaseReceiptsDto extends createZodDto(
  InventoryPaginationSchema.pick({ itemPerPage: true, page: true })
    .extend({
      status: z.enum(PurchaseReceiptStatus).optional(),
      supplierId: z.uuid('Invalid UUID for supplier').optional(),
      receivedFrom: OptionalDateSchema,
      receivedTo: OptionalDateSchema,
    })
    .refine(
      ({ receivedFrom, receivedTo }) =>
        !receivedFrom || !receivedTo || receivedFrom <= receivedTo,
      {
        path: ['receivedFrom'],
        message: 'receivedFrom must be before or equal to receivedTo',
      },
    ),
) {}
