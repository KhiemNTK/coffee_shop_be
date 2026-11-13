import { z } from 'zod';
import type { InvoiceDocumentSnapshot } from '../../common/types';
import type { InvoiceLineSnapshot } from '../../common/types';
import { readSelectedOptions } from '../menu/menu-option-selection';
import { VoucherDiscountSnapshotSchema } from '../../common/validation/voucher-snapshot.schema';

const snapshotSchema = z.object({
  version: z.literal(1),
  source: z.enum(['ISSUED', 'LEGACY_BACKFILL']),
  tableId: z.string().nullable(),
  tableName: z.string().nullable(),
  issuedByName: z.string(),
  promotionName: z.string().nullable(),
  voucher: VoucherDiscountSnapshotSchema.nullable().optional(),
  items: z.array(
    z.object({
      orderItemId: z.string(),
      menuItemId: z.string(),
      name: z.string(),
      quantity: z.number().int().positive(),
      unitPrice: z.string(),
      note: z.string().nullable(),
      selectedOptions: z.array(
        z.object({
          id: z.string(),
          groupName: z.string(),
          name: z.string(),
          priceDelta: z.string(),
        }),
      ),
    }),
  ),
});

export function readInvoiceSnapshot(
  value: unknown,
): InvoiceDocumentSnapshot | null {
  return value == null ? null : snapshotSchema.parse(value);
}

export function createInvoiceSnapshot(input: {
  table: { id: string; name: string } | null;
  issuedByName: string;
  promotionName: string | null;
  voucher?: InvoiceDocumentSnapshot['voucher'];
  items: InvoiceLineSnapshot[];
  source?: InvoiceDocumentSnapshot['source'];
}): InvoiceDocumentSnapshot {
  return {
    version: 1,
    source: input.source ?? 'ISSUED',
    tableId: input.table?.id ?? null,
    tableName: input.table?.name ?? null,
    issuedByName: input.issuedByName,
    promotionName: input.promotionName,
    ...(input.voucher ? { voucher: input.voucher } : {}),
    items: input.items.map((item) => ({
      orderItemId: item.id,
      menuItemId: item.menuItem.id,
      name: item.menuItem.name,
      quantity: item.quantity,
      unitPrice: item.priceAtTime.toFixed(2),
      note: item.note,
      selectedOptions: readSelectedOptions(item.selectedOptions),
    })),
  };
}
