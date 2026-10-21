import { ExecutionContext, Logger, StreamableFile } from '@nestjs/common';
import { Workbook } from 'exceljs';
import { firstValueFrom, of } from 'rxjs';
import { ExcelResponseInterceptor } from './excel-response.interceptor';

describe('ExcelResponseInterceptor', () => {
  const context = {
    getClass: () => class ReportsController {},
  } as unknown as ExecutionContext;
  const interceptor = new ExcelResponseInterceptor();

  afterEach(() => {
    jest.restoreAllMocks();
    jest.useRealTimers();
  });

  it('preserves the Excel filename date and content type', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-10-21T05:00:00Z'));
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    const workbook = new Workbook();
    jest
      .spyOn(workbook.xlsx, 'writeBuffer')
      .mockResolvedValue(new ArrayBuffer(4));
    const file = (await firstValueFrom(
      interceptor.intercept(context, { handle: () => of(workbook) }),
    )) as StreamableFile;
    const date = new Intl.DateTimeFormat('en-CA', {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour12: false,
    })
      .format(new Date())
      .replaceAll('-', '_');
    expect(file.getHeaders()).toMatchObject({
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      disposition: `attachment; filename="reports_${date}.xlsx"`,
    });
  });

  it('leaves non-workbook responses unchanged', async () => {
    const response = { items: [] };
    await expect(
      firstValueFrom(
        interceptor.intercept(context, { handle: () => of(response) }),
      ),
    ).resolves.toBe(response);
  });

  it('propagates workbook generation failures', async () => {
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const workbook = new Workbook();
    const error = new Error('failed to encode workbook');
    jest.spyOn(workbook.xlsx, 'writeBuffer').mockRejectedValue(error);
    await expect(
      firstValueFrom(
        interceptor.intercept(context, { handle: () => of(workbook) }),
      ),
    ).rejects.toBe(error);
  });
});
