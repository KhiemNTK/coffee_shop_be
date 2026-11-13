import { Workbook } from 'exceljs';
import { BankStatementExcelService } from './bank-statement-excel.service';
import { PreviewBankStatementExcelDto } from './dto';

describe('BankStatementExcelService', () => {
  const service = new BankStatementExcelService();
  const config = PreviewBankStatementExcelDto.schema.parse({
    mode: 'ENTRIES',
    fundId: '94000000-0000-4000-8000-000000000001',
    headerRow: 2,
    firstRow: 3,
    lastRow: 3,
    externalIdColumn: 1,
    dateColumn: 2,
    creditColumn: 3,
    debitColumn: 4,
    referenceColumn: 5,
    descriptionColumn: 6,
    moneyFormat: 'VI',
    statementFrom: '2026-11-01T00:00:00+07:00',
    statementTo: '2026-11-02T00:00:00+07:00',
  });
  async function file(values: unknown[], mutate?: (book: Workbook) => void) {
    const book = new Workbook();
    const sheet = book.addWorksheet('Transactions');
    sheet.mergeCells('A1:F1');
    sheet.getCell('A1').value = 'Statement title';
    sheet.addRow(['ID', 'Date', 'Credit', 'Debit', 'Reference', 'Description']);
    sheet.addRow(values);
    mutate?.(book);
    return {
      originalname: 'statement.xlsx',
      buffer: Buffer.from(await book.xlsx.writeBuffer()),
    } as Express.Multer.File;
  }
  const values = [
    'MB-001',
    '01/11/2026 08:30:00',
    '125.000,50',
    '',
    'DEPOSIT-001',
    'Cash handover',
  ];
  it('maps exact amounts, local dates and merged titles without importing money', async () => {
    const result = await service.preview(await file(values), config);
    expect(
      'statement' in result ? result.statement.entries[0] : undefined,
    ).toMatchObject({
      externalId: 'MB-001',
      direction: 'CREDIT',
      amount: '125000.50',
      transactionDate: new Date('2026-11-01T01:30:00Z'),
      bankReference: 'DEPOSIT-001',
    });
  });
  it('inspects columns without requiring transaction mapping', async () => {
    const result = await service.preview(
      await file(values),
      PreviewBankStatementExcelDto.schema.parse({
        mode: 'COLUMNS',
        fundId: config.fundId,
        headerRow: 2,
      }),
    );
    expect(result.columns[0]).toMatchObject({
      index: 1,
      label: 'ID',
      sample: 'MB-001',
    });
    expect(result).not.toHaveProperty('statement');
  });
  it('keeps a wide amount supplied as text without float rounding', async () => {
    const result = await service.preview(
      await file([
        values[0],
        values[1],
        '9999999999999999.99',
        '',
        values[4],
        values[5],
      ]),
      { ...config, moneyFormat: 'PLAIN' },
    );
    expect(
      'statement' in result ? result.statement.entries[0].amount : undefined,
    ).toBe('9999999999999999.99');
  });
  it('rejects wide numeric cells whose source precision Excel may already have lost', async () => {
    await expect(
      service.preview(
        await file([
          values[0],
          values[1],
          1_000_000_000_000_000,
          '',
          values[4],
          values[5],
        ]),
        config,
      ),
    ).rejects.toThrow('exact text');
  });
  it('interprets native Excel dates as a Vietnam wall clock', async () => {
    const result = await service.preview(
      await file([
        values[0],
        new Date('2026-11-01T08:30:00Z'),
        values[2],
        '',
        values[4],
        values[5],
      ]),
      config,
    );
    expect(
      'statement' in result
        ? result.statement.entries[0].transactionDate.toISOString()
        : undefined,
    ).toBe('2026-11-01T01:30:00.000Z');
  });
  it.each([
    [
      'ambiguous amount',
      [values[0], values[1], '1,234.56', '', values[4], values[5]],
    ],
    [
      'both directions',
      [values[0], values[1], values[2], '100', values[4], values[5]],
    ],
    [
      'invalid local date',
      [values[0], '31/02/2026', values[2], '', values[4], values[5]],
    ],
    [
      'invalid ISO date',
      [values[0], '2026-02-31T00:00:00Z', values[2], '', values[4], values[5]],
    ],
    [
      'missing external ID',
      ['', values[1], values[2], '', values[4], values[5]],
    ],
  ])('rejects %s instead of guessing', async (_reason, row) => {
    await expect(service.preview(await file(row), config)).rejects.toThrow();
  });
  it('rejects formulas and merged cells in mapped transaction data', async () => {
    await expect(
      service.preview(
        await file(values, (book) => {
          book.worksheets[0].getCell('C3').value = {
            formula: '100+25',
            result: 125,
          };
        }),
        config,
      ),
    ).rejects.toThrow('formulas');
    await expect(
      service.preview(
        await file(values, (book) => {
          book.worksheets[0].mergeCells('A3:B3');
        }),
        config,
      ),
    ).rejects.toThrow('merged');
  });
  it('bounds row batches and rejects reused mapping columns', () => {
    expect(
      PreviewBankStatementExcelDto.schema.safeParse({ ...config, lastRow: 103 })
        .success,
    ).toBe(false);
    expect(
      PreviewBankStatementExcelDto.schema.safeParse({
        ...config,
        debitColumn: config.creditColumn,
      }).success,
    ).toBe(false);
  });
});
