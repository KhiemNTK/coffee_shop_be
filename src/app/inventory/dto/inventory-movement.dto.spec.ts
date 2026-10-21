import {
  BulkInventoryExportDto,
  BulkInventoryImportDto,
  InventoryExportSchema,
  InventoryImportSchema,
} from './inventory-common.dto';

describe('Stock movement idempotency validation', () => {
  const movement = {
    quantity: '1.25',
    unitPrice: '25000',
    note: 'Stock correction',
  };
  const bulk = {
    items: [
      { ...movement, inventoryItemId: '83000000-0000-4000-8000-000000000001' },
    ],
  };

  it.each([
    [InventoryImportSchema, movement],
    [InventoryExportSchema, movement],
    [BulkInventoryImportDto.schema, bulk],
    [BulkInventoryExportDto.schema, bulk],
  ] as const)(
    'requires a valid key for each movement endpoint',
    (schema, body) => {
      expect(schema.safeParse(body).success).toBe(false);
      expect(
        schema.safeParse({ ...body, idempotencyKey: 'short' }).success,
      ).toBe(false);
      expect(
        schema.safeParse({ ...body, idempotencyKey: 'valid-stock-key' })
          .success,
      ).toBe(true);
    },
  );
});
