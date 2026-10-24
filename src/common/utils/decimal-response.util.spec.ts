import { StreamableFile } from '@nestjs/common';
import { Decimal } from '@prisma/client/runtime/library';
import { Workbook } from 'exceljs';
import { serializeDecimalResponse } from './decimal-response.util';

describe('Decimal response serialization', () => {
  it.each([
    '9999999999999999.99',
    '9007199254740993.01',
    '99999999999999.9999',
    '90071992547410',
  ])('preserves exact wide Decimal %s as a string', (value) => {
    expect(serializeDecimalResponse(new Decimal(value))).toBe(value);
  });

  it.each(['0.29', '1.2345', '12345.67'])(
    'keeps compatible numeric Decimal %s',
    (value) => {
      expect(serializeDecimalResponse(new Decimal(value))).toBe(Number(value));
    },
  );
  it('converts nested Decimals without coercing strings or mutating domain data', () => {
    const source = {
      amount: new Decimal('1.25'),
      items: [new Decimal(2), '2'],
      empty: null,
    };
    expect(serializeDecimalResponse(source)).toEqual({
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
      expect(serializeDecimalResponse(value)).toBe(value);
    },
  );
});
