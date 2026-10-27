import { AddOrderItemsSchema } from './add-order-items.dto';

describe('Order submission idempotency contract', () => {
  const items = [
    { menuItemId: '86000000-0000-4000-8000-000000000001', quantity: 1 },
  ];

  it('requires a retry key and preserves the supported key format', () => {
    for (const idempotencyKey of [
      undefined,
      '',
      '   ',
      'short',
      'a'.repeat(121),
    ]) {
      expect(
        AddOrderItemsSchema.safeParse({ items, idempotencyKey }).success,
      ).toBe(false);
    }
    expect(
      AddOrderItemsSchema.parse({
        items,
        idempotencyKey: '  pos-order-retry-key  ',
      }),
    ).toEqual({ items, idempotencyKey: 'pos-order-retry-key' });
  });
});
