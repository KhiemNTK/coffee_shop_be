import { Decimal } from '@prisma/client/runtime/library';

export function calculateInventoryValue(quantity: Decimal, unitCost: Decimal) {
  return quantity.mul(unitCost).toDecimalPlaces(2);
}

export function calculateWeightedAverageCost(input: {
  stock: Decimal;
  averageUnitCost: Decimal;
  importedQuantity: Decimal;
  importedUnitCost: Decimal;
}) {
  const quantityAfter = input.stock.add(input.importedQuantity);
  if (quantityAfter.isZero()) return new Decimal(0);

  return input.stock
    .mul(input.averageUnitCost)
    .add(input.importedQuantity.mul(input.importedUnitCost))
    .div(quantityAfter)
    .toDecimalPlaces(2);
}
