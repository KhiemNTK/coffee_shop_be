import { TestingModule } from '@nestjs/testing';
import { ExcelUtilService } from './excel-util.service';
import { ExcelUtilModule } from './excel-util.module';
import { AutoMockingModule } from '../../../../test/auto-mocking/auto-mocking.module';
import { BadRequestException, Logger } from '@nestjs/common';
import { ValueType, Workbook } from 'exceljs';
import { createRequire } from 'node:module';
import { EXCEL_IMPORT_LIMITS } from './excel-import-limits';
import type { File } from './dto/excel-util.interface';

describe('ExcelUtilService', () => {
  let service: ExcelUtilService;

  beforeEach(async () => {
    const module: TestingModule = await AutoMockingModule.createTestingModule({
      imports: [ExcelUtilModule],
    });

    service = module.get<ExcelUtilService>(ExcelUtilService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  afterEach(() => jest.restoreAllMocks());

  async function fileFor(workbook: Workbook): Promise<File> {
    const buffer = Buffer.from(await workbook.xlsx.writeBuffer());
    return { buffer, size: buffer.length } as File;
  }

  it('round-trips only explicitly numeric columns and preserves wider precision and identifiers', async () => {
    const row = {
      money: '45000.25',
      quantity: '0.1250',
      percentage: '25.50',
      wide: '123456789012345.67',
      phone: '00973336850',
      name: '=1+1',
      negative: '-1250.50',
      constructor: '00123',
    };
    const workbook = service.generateExcel({
      worksheets: [
        {
          sheetName: 'Numbers',
          data: [row],
          numberFormats: {
            money: '#,##0.00',
            quantity: '#,##0.0000',
            percentage: '0.00"%"',
            wide: '#,##0.00',
            negative: '#,##0.00',
          },
        },
      ],
    });
    const parsed = new Workbook();
    await parsed.xlsx.load(
      (await fileFor(workbook)).buffer as unknown as ArrayBuffer,
    );
    const sheet = parsed.worksheets[0];
    expect(sheet.getCell('A2').value).toBe(45000.25);
    expect(sheet.getCell('A2').numFmt).toBe('#,##0.00');
    expect(sheet.getCell('B2').value).toBe(0.125);
    expect(sheet.getCell('B2').numFmt).toBe('#,##0.0000');
    expect(sheet.getCell('C2').value).toBe(25.5);
    expect(sheet.getCell('C2').numFmt).toBe('0.00"%"');
    expect(sheet.getCell('D2').type).toBe(ValueType.String);
    expect(sheet.getCell('D2').value).toBe(row.wide);
    expect(sheet.getCell('E2').value).toBe(row.phone);
    expect(sheet.getCell('F2').type).toBe(ValueType.String);
    expect(sheet.getCell('G2').value).toBe(-1250.5);
    expect(sheet.getCell('H2').value).toBe('00123');
    expect(row.money).toBe('45000.25');
  });

  it('keeps explicit column headers in empty Excel sheets', async () => {
    const workbook = service.generateExcel({
      worksheets: [
        {
          sheetName: 'Empty',
          data: [],
          fieldsExtend: ['name', 'grossSales'],
          numberFormats: { grossSales: '#,##0.00' },
        },
      ],
    });
    const parsed = new Workbook();
    await parsed.xlsx.load(
      (await fileFor(workbook)).buffer as unknown as ArrayBuffer,
    );
    expect(parsed.worksheets[0].rowCount).toBe(1);
    expect(parsed.worksheets[0].getRow(1).values).toEqual([
      undefined,
      'Name',
      'Gross Sales',
    ]);
  });

  it('reads generated tables, normalizes headers, and preserves hyperlink text', async () => {
    const workbook = service.generateExcel({
      worksheets: [
        {
          sheetName: 'RoleEntity',
          data: [
            {
              name: 'WAITER',
              description: {
                text: 'Customer service',
                hyperlink: 'https://example.test',
              },
            },
          ],
        },
      ],
    });
    await expect(service.read(await fileFor(workbook))).resolves.toEqual({
      RoleEntity: [{ name: 'WAITER', description: 'Customer service' }],
    });
  });

  it('rejects missing/empty buffers and retains bad-request parse errors', async () => {
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    await expect(
      service.read(undefined as unknown as File),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      service.read({ buffer: Buffer.alloc(0) } as File),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      service.read({ buffer: Buffer.from('not an xlsx') } as File),
    ).rejects.toThrow('File Excel is not valid.');
  });

  it('checks actual buffer size before parsing even if file.size is forged', async () => {
    const xlsx = jest.spyOn(Workbook.prototype, 'xlsx', 'get');
    await expect(
      service.read({
        buffer: Buffer.alloc(EXCEL_IMPORT_LIMITS.fileSize + 1),
        size: 1,
      } as File),
    ).rejects.toThrow('Excel file size limit');
    expect(xlsx).not.toHaveBeenCalled();
  });

  it('accepts the worksheet, row, and column boundaries', async () => {
    const workbook = new Workbook();
    for (let index = 0; index < EXCEL_IMPORT_LIMITS.worksheets; index++) {
      const sheet = workbook.addWorksheet(`Sheet${index}`);
      sheet.addRow(
        Array.from({ length: EXCEL_IMPORT_LIMITS.columns }, (_, column) =>
          column === 0 ? 'Name' : `Field ${column}`,
        ),
      );
      sheet.getCell(EXCEL_IMPORT_LIMITS.rows + 1, 1).value = 'Last role';
    }
    const result = await service.read(await fileFor(workbook));
    expect(Object.keys(result)).toHaveLength(EXCEL_IMPORT_LIMITS.worksheets);
    expect(result.Sheet0).toEqual([
      expect.objectContaining({ name: 'Last role' }),
    ]);
  });

  it.each(['worksheets', 'rows', 'columns'] as const)(
    'rejects excess %s before ExcelJS allocates a workbook model',
    async (limit) => {
      const workbook = new Workbook();
      const sheet = workbook.addWorksheet('RoleEntity');
      sheet.addRow(['Name']);
      sheet.addRow(['WAITER']);
      if (limit === 'worksheets') {
        for (let index = 0; index < EXCEL_IMPORT_LIMITS.worksheets; index++) {
          workbook.addWorksheet(`Extra${index}`).addRow(['Name']);
        }
      } else if (limit === 'rows') {
        sheet.getCell(EXCEL_IMPORT_LIMITS.rows + 2, 1).value = 'Too far';
      } else {
        sheet.getCell(2, EXCEL_IMPORT_LIMITS.columns + 1).value = 'Too far';
      }
      const file = await fileFor(workbook);
      const xlsx = jest.spyOn(Workbook.prototype, 'xlsx', 'get');
      await expect(service.read(file)).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(xlsx).not.toHaveBeenCalled();
    },
  );

  it('rejects ambiguous normalized headers', async () => {
    const workbook = new Workbook();
    const sheet = workbook.addWorksheet('RoleEntity');
    sheet.addRow(['Role Name', 'role_name']);
    sheet.addRow(['WAITER', 'ADMIN']);
    await expect(service.read(await fileFor(workbook))).rejects.toThrow(
      'duplicate headers',
    );
  });

  it('does not interpret sheet or header names as object prototypes', async () => {
    const workbook = new Workbook();
    const sheet = workbook.addWorksheet('__proto__');
    sheet.addRow(['Name', 'constructor']);
    sheet.addRow(['WAITER', 'Untrusted']);
    const result = await service.read(await fileFor(workbook));
    expect(Object.getPrototypeOf(result)).toBeNull();
    expect(Object.getPrototypeOf(result.__proto__[0])).toBeNull();
    expect(result.__proto__[0]).toEqual({
      name: 'WAITER',
      constructor: 'Untrusted',
    });
  });

  it('ignores validation ranges instead of expanding them into cell objects', async () => {
    const workbook = new Workbook();
    const sheet = workbook.addWorksheet('RoleEntity');
    sheet.addRow(['Name']);
    sheet.addRow(['WAITER']);
    const validations = sheet as unknown as {
      dataValidations: { add(range: string, value: object): void };
    };
    validations.dataValidations.add('A1:XFD1048576', {
      type: 'list',
      formulae: ['"WAITER,MANAGER"'],
    });
    await expect(service.read(await fileFor(workbook))).resolves.toEqual({
      RoleEntity: [{ name: 'WAITER' }],
    });
  });
});

describe('Excel import archive bounds', () => {
  const service = new ExcelUtilService();
  const excelRequire = createRequire(require.resolve('exceljs'));
  const JSZip = excelRequire('jszip') as new () => {
    file(name: string, data: string): void;
    generateAsync(options: {
      type: 'nodebuffer';
      compression: 'DEFLATE';
    }): Promise<Buffer>;
  };

  afterEach(() => jest.restoreAllMocks());

  async function archiveFile(entries: Record<string, string>): Promise<File> {
    const zip = new JSZip();
    for (const [name, data] of Object.entries(entries)) zip.file(name, data);
    const buffer = await zip.generateAsync({
      type: 'nodebuffer',
      compression: 'DEFLATE',
    });
    return { buffer, size: buffer.length } as File;
  }

  async function expectEarlyRejection(file: File, message: string) {
    const xlsx = jest.spyOn(Workbook.prototype, 'xlsx', 'get');
    await expect(service.read(file)).rejects.toThrow(message);
    expect(xlsx).not.toHaveBeenCalled();
  }

  it('bounds actual expansion of a small compressed archive', async () => {
    const file = await archiveFile({
      'xl/media/padding.bin': 'x'.repeat(EXCEL_IMPORT_LIMITS.expandedSize + 1),
    });
    expect(file.buffer.length).toBeLessThan(EXCEL_IMPORT_LIMITS.fileSize);
    await expectEarlyRejection(file, 'expanded size limit');
  });

  it('does not trust the declared uncompressed ZIP entry size', async () => {
    const file = await archiveFile({
      'padding.bin': 'x'.repeat(EXCEL_IMPORT_LIMITS.expandedSize + 1),
    });
    const directory = file.buffer.indexOf(
      Buffer.from([0x50, 0x4b, 0x01, 0x02]),
    );
    file.buffer.writeUInt32LE(1, 22);
    file.buffer.writeUInt32LE(1, directory + 24);
    await expectEarlyRejection(file, 'expanded size limit');
  });

  it('rejects excessive ZIP entries', async () => {
    const file = await archiveFile(
      Object.fromEntries(
        Array.from(
          { length: EXCEL_IMPORT_LIMITS.archiveEntries + 1 },
          (_, i) => [`entry${i}.txt`, ''],
        ),
      ),
    );
    await expectEarlyRejection(file, 'archive entry limit');
  });

  it.each([
    [
      'row count',
      '<row r="1"/>'.repeat(EXCEL_IMPORT_LIMITS.rows + 2),
      'row limit',
    ],
    ['sparse row', '<row r="999999999"/>', 'row limit'],
    ['sparse column', '<row r="2"><c r="XFD2"/></row>', 'column limit'],
    ['column metadata', '<col min="1" max="999999999"/>', 'column limit'],
    ['merged range', '<mergeCell ref="A1:XFD1048576"/>', 'merged cells'],
    [
      'cell count',
      `<row r="1">${'<c r="A1"/>'.repeat(EXCEL_IMPORT_LIMITS.cells + 1)}</row>`,
      'cell limit',
    ],
    [
      'XML node count',
      '<x/>'.repeat(EXCEL_IMPORT_LIMITS.xmlNodes + 1),
      'XML node limit',
    ],
  ])('rejects %s before allocating model data', async (_, content, message) => {
    const file = await archiveFile({
      'xl/worksheets/sheet1.xml': `<worksheet>${content}</worksheet>`,
    });
    await expectEarlyRejection(file, message);
  });

  it('applies bounds to worksheet paths matched by ExcelJS, including suffixes', async () => {
    const file = await archiveFile({
      'xl/worksheets/sheet1.xml.extra':
        '<worksheet><row r="999999999"/></worksheet>',
    });
    await expectEarlyRejection(file, 'row limit');
  });

  it('rejects workbook named ranges before their cells can be expanded', async () => {
    const file = await archiveFile({
      'xl/workbook.xml':
        '<workbook><definedNames><definedName name="boom">Sheet1!A1:XFD1048576</definedName></definedNames></workbook>',
    });
    await expectEarlyRejection(file, 'named ranges');
  });

  it('rejects XML document types', async () => {
    const file = await archiveFile({
      'xl/worksheets/sheet1.xml': '<!DOCTYPE worksheet><worksheet/>',
    });
    await expectEarlyRejection(file, 'document types');
  });

  it('bounds deeply nested XML before retaining an oversized element stack', async () => {
    const depth = EXCEL_IMPORT_LIMITS.xmlDepth + 1;
    const file = await archiveFile({
      'xl/worksheets/sheet1.xml': '<x>'.repeat(depth) + '</x>'.repeat(depth),
    });
    await expectEarlyRejection(file, 'XML nesting limit');
  });

  it('keeps corrupt XML as a bad request, not an uncaught parser failure', async () => {
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const file = await archiveFile({
      'xl/worksheets/sheet1.xml': '<worksheet><row r="1"></worksheet>',
    });
    await expectEarlyRejection(file, 'File Excel is not valid.');
  });
});
