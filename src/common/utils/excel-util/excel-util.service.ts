import { WORKSHEETS_IS_EMPTY, FILE_NOT_FOUND } from './../../consts/message';
import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { Workbook } from 'exceljs';
import type { CellValue, Worksheet } from 'exceljs';
import { startCase } from 'lodash';
import { File, GenerateExcelParams } from './dto/excel-util.interface';
import { camelCase } from 'es-toolkit';

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
      throw new BadRequestException(WORKSHEETS_IS_EMPTY);
    }
    const workbook = new Workbook();
    for (const workSheetData of worksheets) {
      const {
        sheetName = 'Sheet Name',
        data = [],
        fieldsExclude = ['id'],
        fieldsMapping,
        fieldsExtend = [],
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
            header: startCase(mappedHeaderName),
            key: field,
            width: 25,
          };
        });

      worksheet.columns = columns;
      worksheet.addRows(data);

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

  generateExcelSheetsName(
    services: Record<string, string>,
  ): Record<string, string> {
    return Object.keys(services).reduce((acc, service) => {
      acc[service] = service.replace(`Service`, '');
      return acc;
    }, {});
  }

  async read(file: File) {
    if (!file || !file.buffer) throw new BadRequestException(FILE_NOT_FOUND);
    const workbook = new Workbook();
    try {
      await workbook.xlsx.load(file.buffer as unknown as ArrayBuffer);
    } catch (error) {
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
            headerMap.set(colNumber, camelCase(String(cell.text)));
          }
        });
        worksheet.eachRow((row, rowNumber) => {
          if (rowNumber === 1) return;

          const value: Record<string, unknown> = {};

          headerMap.forEach((fieldName, colNumber) => {
            const rawValue = row.getCell(colNumber).value;
            value[fieldName] = this.cleanData(rawValue);
          });
          sheetData.push(value);
        });
        acc[worksheet.name] = sheetData;
        return acc;
      },
      {},
    );
    return sheetsData;
  }
}
