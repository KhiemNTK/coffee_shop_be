import {
  BadRequestException,
  ConflictException,
  Injectable,
} from '@nestjs/common';
import { Decimal } from '@prisma/client/runtime/library';

@Injectable()
export class InventoryPolicyService {
  readonly bulkMovementLimit = 100;

  toPositiveDecimal(value: string | number | Decimal, fieldName: string) {
    const decimal = new Decimal(value).toDecimalPlaces(4);
    if (!decimal.isFinite() || decimal.lte(0)) {
      throw new BadRequestException(`${fieldName} must be greater than 0.`);
    }
    return decimal;
  }

  toNonNegativeDecimal(value: string | number | Decimal, fieldName: string) {
    const decimal = new Decimal(value).toDecimalPlaces(4);
    if (!decimal.isFinite() || decimal.lt(0)) {
      throw new BadRequestException(
        `${fieldName} must be greater than or equal to 0.`,
      );
    }
    return decimal;
  }

  assertActiveEmployee(employee: { isActive: boolean } | null) {
    if (!employee?.isActive) {
      throw new BadRequestException('Employee is inactive or not found.');
    }
  }

  assertNoIdempotencyKey(idempotencyKey?: string) {
    if (idempotencyKey) {
      throw new BadRequestException(
        'idempotencyKey requires a persisted idempotency store before it can be supported safely.',
      );
    }
  }

  assertBulkSize(size: number) {
    if (size < 1 || size > this.bulkMovementLimit) {
      throw new BadRequestException(
        `Bulk inventory movements must contain between 1 and ${this.bulkMovementLimit} items.`,
      );
    }
  }

  assertNoDuplicateInventoryItems(inventoryItemIds: string[]) {
    const duplicateIds = inventoryItemIds.filter(
      (id, index) => inventoryItemIds.indexOf(id) !== index,
    );
    if (duplicateIds.length > 0) {
      throw new ConflictException(
        `Duplicate inventory item IDs are not allowed: ${[
          ...new Set(duplicateIds),
        ].join(', ')}`,
      );
    }
  }

  assertCanDeleteCategory(linkedItemsCount: number) {
    if (linkedItemsCount > 0) {
      throw new ConflictException(
        'Cannot delete inventory category while active inventory items still reference it.',
      );
    }
  }

  assertCanDeleteUnit(linkedItemsCount: number) {
    if (linkedItemsCount > 0) {
      throw new ConflictException(
        'Cannot delete unit while active inventory items still reference it.',
      );
    }
  }

  assertCanDeleteItem({
    activeRecipeLinks,
    stock,
  }: {
    activeRecipeLinks: number;
    stock: Decimal;
  }) {
    if (activeRecipeLinks > 0) {
      throw new ConflictException(
        'Cannot delete inventory item while menu recipes still reference it.',
      );
    }

    if (!stock.eq(0)) {
      throw new ConflictException(
        'Cannot delete inventory item while stock is not zero.',
      );
    }
  }
}
