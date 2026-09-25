import { Decimal } from '@prisma/client/runtime/library';
import {
  calculateInventoryValue,
  calculateWeightedAverageCost,
} from './inventory-costing';

describe('inventory costing', () => {
  it('calculates weighted-average cost from carrying and imported value', () => {
    expect(
      calculateWeightedAverageCost({
        stock: new Decimal(10),
        averageUnitCost: new Decimal(20_000),
        importedQuantity: new Decimal(5),
        importedUnitCost: new Decimal(23_000),
      }).toString(),
    ).toBe('21000');
  });

  it('rounds inventory values to money precision', () => {
    expect(
      calculateInventoryValue(
        new Decimal('0.3333'),
        new Decimal('12345.67'),
      ).toString(),
    ).toBe('4114.81');
  });

  it('does not round carrying values before calculating the average', () => {
    expect(
      calculateWeightedAverageCost({
        stock: new Decimal('0.0001'),
        averageUnitCost: new Decimal(1),
        importedQuantity: new Decimal('0.0001'),
        importedUnitCost: new Decimal(2),
      }).toString(),
    ).toBe('1.5');
  });
});
