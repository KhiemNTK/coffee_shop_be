import { StreamableFile } from '@nestjs/common';
import { Decimal } from '@prisma/client/runtime/library';
import { Workbook } from 'exceljs';

export function convertDecimalsToNumbers(data: unknown): unknown {
  if (data === null || typeof data !== 'object') return data;
  if (data instanceof Decimal) return data.toNumber();
  if (
    data instanceof Date ||
    data instanceof StreamableFile ||
    data instanceof Workbook
  )
    return data;
  if (Array.isArray(data)) return data.map(convertDecimalsToNumbers);

  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    result[key] = convertDecimalsToNumbers(value);
  }
  return result;
}
