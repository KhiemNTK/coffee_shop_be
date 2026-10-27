import { SYSTEM_ERRORS } from './../../consts/message';
import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { type CellValue, Workbook, type Worksheet } from 'exceljs';
import { File, GenerateExcelParams } from './dto/excel-util.interface';
import { EXCEL_IMPORT_LIMITS } from './excel-import-limits';
import { validateExcelArchive } from './excel-import-guard';
import { Decimal } from '@prisma/client/runtime/library';

function excelNumericValue(value: unknown) {
  if (typeof value !== 'string' || !/^-?\d+(?:\.\d+)?$/.test(value))
    return value;
  const decimal = new Decimal(value);
  const numeric = decimal.toNumber();
  // Excel retains 15 significant digits; preserve wider values as exact text.
  return decimal.precision() <= 15 &&
    Number.isFinite(numeric) &&
    decimal.equals(numeric)
    ? numeric
    : value;
}

const toCamelCase = (str: string): string =>
  str
    .trim()
    .replace(/[-_\s]+(.)?/g, (_, c) => (c ? c.toUpperCase() : ''))
    .replace(/^(.)/, (c) => c.toLowerCase());

const toStartCase = (str: string) =>
  str
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .replace(/\b\w/g, (char) => char.toUpperCase())
    .trim();

@Injectable()
export class ExcelUtilService {
  private readonly logger = new Logger(ExcelUtilService.name);

  private customHeaders(worksheet: Worksheet) {
    const headerRow = worksheet.getRow(1);
    headerRow.font = {
      size: 18,
      bold: true,
    };
    headerRow.alignment = {
      horizontal: 'center',
      vertical: 'middle',
    };
    headerRow.eachCell({ includeEmpty: false }, (cell) => {
      cell.fill = {
        type: 'pattern',
        pattern: 'solid',
        fgColor: { argb: 'FFD9D9D9' },
      };
      cell.border = {
        top: { style: 'thin' },
        left: { style: 'thin' },
        bottom: { style: 'thin' },
        right: { style: 'thin' },
      };
    });
  }

  generateExcel({ worksheets = [] }: GenerateExcelParams) {
    if (!worksheets || worksheets.length === 0) {
      throw new BadRequestException(SYSTEM_ERRORS.WORKSHEETS_IS_EMPTY);
    }
    const workbook = new Workbook();
    for (const workSheetData of worksheets) {
      const {
        sheetName = 'Sheet Name',
        data = [],
        fieldsExclude = ['id'],
        fieldsMapping,
        fieldsExtend = [],
        numberFormats = {},
      } = workSheetData;

      const worksheet = workbook.addWorksheet(sheetName);
      const baseFields =
        data.length > 0
          ? Object.keys(data[0] as Record<string, unknown>)
          : fieldsExtend;

      const columns = baseFields
        .filter((field) => !fieldsExclude.includes(field))
        .map((field) => {
          const mappedHeaderName = fieldsMapping?.[field] ?? field;
          return {
            header: toStartCase(mappedHeaderName),
            key: field,
            width: 25,
            style: {
              numFmt: Object.hasOwn(numberFormats, field)
                ? numberFormats[field]
                : undefined,
            },
          };
        });

      worksheet.columns = columns;
      worksheet.addRows(
        data.map((row: Record<string, unknown>) =>
          Object.fromEntries(
            Object.entries(row).map(([field, value]) => [
              field,
              Object.hasOwn(numberFormats, field)
                ? excelNumericValue(value)
                : value,
            ]),
          ),
        ),
      );

      this.customHeaders(worksheet);
    }
    return workbook;
  }

  private convertHyperlinkToString(value: CellValue): CellValue {
    return value && typeof value === 'object' && 'text' in value
      ? value.text
      : value;
  }

  private cleanData(value: CellValue): any {
    return this.convertHyperlinkToString(value);
  }

  async read(file: File) {
    if (!file || !Buffer.isBuffer(file.buffer) || file.buffer.length === 0)
      throw new BadRequestException(SYSTEM_ERRORS.FILE_NOT_FOUND);
    if (file.buffer.length > EXCEL_IMPORT_LIMITS.fileSize) {
      throw new BadRequestException(
        `Excel file size limit (${EXCEL_IMPORT_LIMITS.fileSize} bytes) exceeded.`,
      );
    }
    const workbook = new Workbook();
    try {
      await validateExcelArchive(file.buffer);
      // Validation ranges are not imported and can expand into millions of cells.
      await workbook.xlsx.load(file.buffer as unknown as ArrayBuffer, {
        ignoreNodes: ['dataValidations', 'conditionalFormatting', 'extLst'],
      });
    } catch (error) {
      if (error instanceof BadRequestException) throw error;
      const errorMessage =
        error instanceof Error ? error.message : 'Unknown error';
      this.logger.error(`Excel parse error: ${errorMessage}`);
      throw new BadRequestException('File Excel is not valid.');
    }

    const sheetsData = workbook.worksheets.reduce<Record<string, object[]>>(
      (acc, worksheet) => {
        const sheetData: object[] = [];
        const headerMap = new Map<number, string>();
        worksheet.getRow(1).eachCell((cell, colNumber) => {
          if (cell.text) {
            const header = toCamelCase(String(cell.text));
            if (!header || [...headerMap.values()].includes(header)) {
              throw new BadRequestException(
                `Sheet '${worksheet.name}' contains empty or duplicate headers.`,
              );
            }
            headerMap.set(colNumber, header);
          }
        });
        worksheet.eachRow((row, rowNumber) => {
          if (rowNumber === 1) return;

          const value: Record<string, unknown> = Object.create(null);

          headerMap.forEach((fieldName, colNumber) => {
            const rawValue = row.getCell(colNumber).value;
            value[fieldName] = this.cleanData(rawValue);
          });
          sheetData.push(value);
        });
        acc[worksheet.name] = sheetData;
        return acc;
      },
      Object.create(null) as Record<string, object[]>,
    );
    return sheetsData;
  }
}
