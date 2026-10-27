import { GetInvoicesPaginationDto } from './get-invoice.dto';

describe('Invoice search contract', () => {
  it('trims and bounds global search and integer pagination', () => {
    expect(
      GetInvoicesPaginationDto.schema.parse({ keyword: '  INV-001  ' }).keyword,
    ).toBe('INV-001');
    for (const input of [
      { keyword: 'x'.repeat(121) },
      { keyword: ' ' },
      { page: 1.5 },
      { itemPerPage: 1.5 },
    ]) {
      expect(GetInvoicesPaginationDto.schema.safeParse(input).success).toBe(
        false,
      );
    }
  });
  it('accepts exact UTC boundaries and rejects reversed ranges', () => {
    expect(
      GetInvoicesPaginationDto.schema.safeParse({
        createdFrom: '2026-10-01T17:00:00.000Z',
        createdTo: '2026-10-02T16:59:59.999Z',
      }).success,
    ).toBe(true);
    expect(
      GetInvoicesPaginationDto.schema.safeParse({
        createdFrom: '2026-10-02T17:00:00.000Z',
        createdTo: '2026-10-01T17:00:00.000Z',
      }).success,
    ).toBe(false);
  });
});
