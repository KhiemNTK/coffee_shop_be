import { BadRequestException, ConflictException } from '@nestjs/common';
import { Decimal } from '@prisma/client/runtime/library';
import { InventoryPolicyService } from './inventory-policy.service';

describe('InventoryPolicyService', () => {
  let service: InventoryPolicyService;

  beforeEach(() => {
    service = new InventoryPolicyService();
  });

  it('accepts positive decimals', () => {
    expect(service.toPositiveDecimal('1.2500', 'quantity').eq(1.25)).toBe(true);
  });

  it('rejects non-positive quantities', () => {
    expect(() => service.toPositiveDecimal(0, 'quantity')).toThrow(
      BadRequestException,
    );
  });

  it('rejects unsafe idempotency without a persisted store', () => {
    expect(() => service.assertNoIdempotencyKey('request-123')).toThrow(
      BadRequestException,
    );
  });

  it('rejects duplicate item IDs in bulk movements', () => {
    expect(() =>
      service.assertNoDuplicateInventoryItems(['item-1', 'item-1']),
    ).toThrow(ConflictException);
  });

  it('rejects deleting an item while it is linked or stocked', () => {
    expect(() =>
      service.assertCanDeleteItem({
        activeRecipeLinks: 1,
        stock: new Decimal(0),
      }),
    ).toThrow(ConflictException);

    expect(() =>
      service.assertCanDeleteItem({
        activeRecipeLinks: 0,
        stock: new Decimal(1),
      }),
    ).toThrow(ConflictException);
  });
});
