import {
  MoneyInputSchema,
  TaxRateInputSchema,
} from '../../common/validation/money.schema';
import { VoidInvoiceDto } from './dto';
import { CancelSessionDto, ClearDiningTableDto } from '../orders/dto';

describe('Invoice and table input boundaries', () => {
  it.each(['0', '35000.25', '9999999999999999.99', 35000.25])(
    'accepts exact money %s',
    (value) => {
      expect(MoneyInputSchema.safeParse(value).success).toBe(true);
    },
  );

  it.each([
    '1.005',
    '10000000000000000',
    '-1',
    '1e8',
    1.005,
    NaN,
    Infinity,
    Number.MAX_SAFE_INTEGER,
  ])('rejects unsafe money %s', (value) => {
    expect(MoneyInputSchema.safeParse(value).success).toBe(false);
  });

  it.each(['8.125', '100.01', '-1', 8.125])(
    'rejects tax incompatible with storage %s',
    (value) => {
      expect(TaxRateInputSchema.safeParse(value).success).toBe(false);
    },
  );

  it.each(['0', '8', '8.13', '100'])('accepts tax %s', (value) => {
    expect(TaxRateInputSchema.safeParse(value).success).toBe(true);
  });

  it('requires an explicit cancellation reason at each HTTP boundary', () => {
    expect(VoidInvoiceDto.schema.safeParse({}).success).toBe(false);
    expect(CancelSessionDto.schema.safeParse({ reason: '  ' }).success).toBe(
      false,
    );
    expect(
      ClearDiningTableDto.schema.safeParse({ expectedOrderSessionId: null })
        .success,
    ).toBe(false);
    expect(
      VoidInvoiceDto.schema.parse({ reason: '  Duplicate bill  ' }).reason,
    ).toBe('Duplicate bill');
  });
});
