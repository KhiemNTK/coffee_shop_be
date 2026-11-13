import { BadRequestException, Injectable } from '@nestjs/common';
import { Workbook, type Cell } from 'exceljs';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { validateExcelArchive } from '../../common/utils/excel-util/excel-import-guard';
import { EXCEL_IMPORT_LIMITS } from '../../common/utils/excel-util/excel-import-limits';
import {
  CreateBankStatementImportDto,
  PreviewBankStatementExcelDto,
} from './dto';

const VIETNAM_OFFSET_MS = 7 * 60 * 60 * 1000;

@Injectable()
export class BankStatementExcelService {
  async preview(
    file: Express.Multer.File,
    config: PreviewBankStatementExcelDto,
  ) {
    if (
      !file?.buffer?.length ||
      file.buffer.length > EXCEL_IMPORT_LIMITS.fileSize
    )
      throw new BadRequestException(
        'Upload a nonempty .xlsx file within 5 MB.',
      );
    const workbook = new Workbook();
    try {
      await validateExcelArchive(file.buffer, true);
      await workbook.xlsx.load(file.buffer as unknown as ArrayBuffer, {
        ignoreNodes: ['dataValidations', 'conditionalFormatting', 'extLst'],
      });
    } catch (error) {
      if (error instanceof BadRequestException) throw error;
      throw new BadRequestException('Invalid Excel workbook.');
    }
    const sheet = workbook.worksheets[config.sheet - 1];
    if (!sheet || config.headerRow > sheet.rowCount)
      throw new BadRequestException('Worksheet or header row not found.');
    const columns = Array.from({ length: sheet.columnCount }, (_, index) => ({
      index: index + 1,
      label: sheet
        .getRow(config.headerRow)
        .getCell(index + 1)
        .text.slice(0, 120),
      sample: sheet
        .getRow(config.headerRow + 1)
        .getCell(index + 1)
        .text.slice(0, 120),
    }));
    const result = {
      sheets: workbook.worksheets.map((item) => item.name),
      columns,
      rowCount: sheet.rowCount,
    };
    if (config.mode === 'COLUMNS') return result;
    if (config.lastRow! > sheet.rowCount)
      throw new BadRequestException('Transaction range exceeds the worksheet.');
    const entries: unknown[] = [];
    for (let number = config.firstRow!; number <= config.lastRow!; number++) {
      const row = sheet.getRow(number);
      const read = (column: number | undefined) =>
        column ? this.cell(row.getCell(column), number) : '';
      const externalId = read(config.externalIdColumn);
      const date = read(config.dateColumn);
      const credit = read(config.creditColumn);
      const debit = read(config.debitColumn);
      const reference = read(config.referenceColumn);
      const description = read(config.descriptionColumn);
      if (
        [externalId, date, credit, debit, reference, description].every(
          (value) => value === '',
        )
      )
        continue;
      const incoming = this.amount(credit, config.moneyFormat, number);
      const outgoing = this.amount(debit, config.moneyFormat, number);
      if (incoming.gt(0) === outgoing.gt(0))
        throw new BadRequestException(
          `Row ${number}: exactly one credit or debit amount is required.`,
        );
      entries.push({
        externalId: String(externalId).trim(),
        direction: incoming.gt(0) ? 'CREDIT' : 'DEBIT',
        amount: (incoming.gt(0) ? incoming : outgoing).toFixed(2),
        transactionDate: this.date(date, number),
        ...(reference !== ''
          ? { bankReference: String(reference).trim() }
          : {}),
        ...(description !== ''
          ? { description: String(description).trim() }
          : {}),
      });
    }
    const parsed = CreateBankStatementImportDto.schema.safeParse({
      fundId: config.fundId,
      sourceFileName: file.originalname,
      statementFrom: config.statementFrom,
      statementTo: config.statementTo,
      entries,
    });
    if (!parsed.success)
      throw new BadRequestException({
        code: 'BANK_EXCEL_INVALID',
        message: parsed.error.issues
          .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
          .join('; ')
          .slice(0, 2000),
      });
    return { ...result, statement: parsed.data };
  }

  private cell(cell: Cell, row: number): string | number | Date {
    if (
      cell.isMerged ||
      (cell.value &&
        typeof cell.value === 'object' &&
        ('formula' in cell.value || 'sharedFormula' in cell.value))
    )
      throw new BadRequestException(
        `Row ${row}: mapped transaction cells cannot be merged or contain formulas.`,
      );
    const value = cell.value;
    if (value === null || value === undefined) return '';
    if (value instanceof Date) return value;
    if (typeof value === 'number') {
      if (
        !Number.isFinite(value) ||
        Math.abs(value) >= 1e15 ||
        new Prisma.Decimal(String(value)).precision() > 15
      )
        throw new BadRequestException(
          `Row ${row}: wide numeric cells must be stored as exact text.`,
        );
      return value;
    }
    if (typeof value === 'string') return value.trim();
    // Rich text is display-only text; links/errors/formula results are not bank evidence.
    if (typeof value === 'object' && 'richText' in value)
      return value.richText
        .map((part) => part.text)
        .join('')
        .trim();
    throw new BadRequestException(`Row ${row}: unsupported cell value.`);
  }

  private amount(
    value: string | number | Date,
    format: PreviewBankStatementExcelDto['moneyFormat'],
    row: number,
  ) {
    let text = String(value).trim();
    if (text === '' || text === '-') return new Prisma.Decimal(0);
    if (typeof value === 'number') text = String(value);
    else if (format === 'VI') {
      if (!/^(?:\d+|\d{1,3}(?:\.\d{3})+)(?:,\d{1,2})?$/.test(text))
        throw new BadRequestException(
          `Row ${row}: invalid Vietnamese amount format.`,
        );
      text = text.replaceAll('.', '').replace(',', '.');
    } else if (format === 'EN') {
      if (!/^(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d{1,2})?$/.test(text))
        throw new BadRequestException(
          `Row ${row}: invalid English amount format.`,
        );
      text = text.replaceAll(',', '');
    }
    if (!/^\d{1,16}(?:\.\d{1,2})?$/.test(text))
      throw new BadRequestException(
        `Row ${row}: amount must be nonnegative with at most two decimal places.`,
      );
    return new Prisma.Decimal(text);
  }

  private date(value: string | number | Date, row: number) {
    // Excel dates have no zone; interpret their calendar fields in the store's UTC+7 zone.
    if (value instanceof Date && Number.isFinite(value.getTime()))
      return new Date(value.getTime() - VIETNAM_OFFSET_MS).toISOString();
    const text = String(value).trim();
    const iso =
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(
        text,
      );
    if (iso && z.iso.datetime({ offset: true }).safeParse(text).success)
      return new Date(text).toISOString();
    const match =
      /^(\d{2})\/(\d{2})\/(\d{4})(?: (\d{2}):(\d{2})(?::(\d{2}))?)?$/.exec(
        text,
      );
    if (!match)
      throw new BadRequestException(
        `Row ${row}: use an Excel date, dd/MM/yyyy [HH:mm:ss], or ISO date with timezone.`,
      );
    const [, day, month, year, hour = '00', minute = '00', second = '00'] =
      match;
    const date = new Date(
      `${year}-${month}-${day}T${hour}:${minute}:${second}Z`,
    );
    if (
      !Number.isFinite(date.getTime()) ||
      date.getUTCDate() !== Number(day) ||
      date.getUTCMonth() + 1 !== Number(month)
    )
      throw new BadRequestException(`Row ${row}: invalid calendar date.`);
    return new Date(date.getTime() - VIETNAM_OFFSET_MS).toISOString();
  }
}
