import { StreamableFile } from '@nestjs/common';
import { Decimal } from '@prisma/client/runtime/library';
import { Workbook } from 'exceljs';

export function serializeDecimalResponse(data: unknown): unknown {
  if (data === null || typeof data !== 'object') return data;
  if (data instanceof Decimal) {
    const numeric = data.toNumber();
    // Keep legacy numeric responses only when they also fit the money adapter.
    return Math.abs(numeric) <= Number.MAX_SAFE_INTEGER / 100 &&
      data.equals(numeric)
      ? numeric
      : data.toFixed();
  }
  if (
    data instanceof Date ||
    data instanceof StreamableFile ||
    data instanceof Workbook
  )
    return data;
  if (Array.isArray(data)) return data.map(serializeDecimalResponse);

  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    result[key] = serializeDecimalResponse(value);
  }
  return result;
}
