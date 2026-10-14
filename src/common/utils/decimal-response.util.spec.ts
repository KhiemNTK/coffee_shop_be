import { StreamableFile } from '@nestjs/common';
import { Decimal } from '@prisma/client/runtime/library';
import { Workbook } from 'exceljs';
import { convertDecimalsToNumbers } from './decimal-response.util';

describe('Decimal response serialization', () => {
  it('converts nested Decimals without coercing strings or mutating domain data', () => {
    const source = {
      amount: new Decimal('1.25'),
      items: [new Decimal(2), '2'],
      empty: null,
    };
    expect(convertDecimalsToNumbers(source)).toEqual({
      amount: 1.25,
      items: [2, '2'],
      empty: null,
    });
    expect(source.amount).toBeInstanceOf(Decimal);
    expect(source.items[0]).toBeInstanceOf(Decimal);
  });

  it.each([
    new Date(),
    new StreamableFile(Buffer.from('file')),
    new Workbook(),
  ])(
    'preserves response objects requiring their original prototype',
    (value) => {
      expect(convertDecimalsToNumbers(value)).toBe(value);
    },
  );
});
