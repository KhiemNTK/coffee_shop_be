import {
  InventoryDecimalInputSchema,
  InventoryPaginationSchema,
  MoneyInputSchema,
} from './inventory-common.dto';
import { GetInventoryItemsDto } from './inventory-item.dto';
import { PostPurchaseReceiptDto } from './purchase-receipt.dto';

describe('Inventory boundary validation', () => {
  it.each([
    [undefined, false],
    ['false', false],
    ['true', true],
    [false, false],
    [true, true],
  ])('parses lowStockOnly %s as %s', (value, expected) => {
    expect(
      GetInventoryItemsDto.schema.parse({ lowStockOnly: value }).lowStockOnly,
    ).toBe(expected);
  });

  it.each(['0', 'yes', '', 'FALSE', 1, []])(
    'rejects ambiguous lowStockOnly %s',
    (value) => {
      expect(
        GetInventoryItemsDto.schema.safeParse({ lowStockOnly: value }).success,
      ).toBe(false);
    },
  );

  it.each([{ page: '1.5' }, { itemPerPage: '1.5' }, { page: '1000000000000' }])(
    'rejects invalid pagination %s',
    (input) => {
      expect(InventoryPaginationSchema.safeParse(input).success).toBe(false);
    },
  );

  it.each(['0', '0.0001', '99999999999999.9999', 0.1234])(
    'accepts representable quantities %s',
    (value) => {
      expect(InventoryDecimalInputSchema.safeParse(value).success).toBe(true);
    },
  );

  it.each([
    '100000000000000',
    '0.00001',
    100_000_000_000_000,
    0.00001,
    Infinity,
    -1,
  ])('rejects out-of-range or over-precise quantities %s', (value) => {
    expect(InventoryDecimalInputSchema.safeParse(value).success).toBe(false);
  });

  it.each(['9999999999999999.99', '0.01', 12.34])(
    'accepts representable money %s',
    (value) => {
      expect(MoneyInputSchema.safeParse(value).success).toBe(true);
    },
  );

  it.each(['10000000000000000', '0.001', 10_000_000_000_000_000, 0.001])(
    'rejects out-of-range or over-precise money %s',
    (value) => {
      expect(MoneyInputSchema.safeParse(value).success).toBe(false);
    },
  );

  it('requires the reviewed receipt timestamp and rejects missing or invalid tokens', () => {
    const request = { idempotencyKey: 'receipt-post-key' };
    expect(PostPurchaseReceiptDto.schema.safeParse(request).success).toBe(
      false,
    );
    expect(
      PostPurchaseReceiptDto.schema.safeParse({
        ...request,
        expectedUpdatedAt: 'not-a-date',
      }).success,
    ).toBe(false);
    expect(
      PostPurchaseReceiptDto.schema.parse({
        ...request,
        expectedUpdatedAt: '2026-10-23T00:00:00.000Z',
      }).expectedUpdatedAt,
    ).toEqual(new Date('2026-10-23T00:00:00.000Z'));
  });
});
