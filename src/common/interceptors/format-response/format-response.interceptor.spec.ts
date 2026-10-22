import { FormatResponseInterceptor } from './format-response.interceptor';
import { StreamableFile } from '@nestjs/common';
import { Workbook } from 'exceljs';
import { SSE_METADATA } from '@nestjs/common/constants';
import { firstValueFrom, of, throwError } from 'rxjs';

describe('FormatResponseInterceptor', () => {
  const interceptor = new FormatResponseInterceptor();

  it('wraps regular responses without changing their data or message', async () => {
    const data = { id: 'order-id', message: 'Created' };
    const result = await firstValueFrom(
      interceptor.intercept({ getHandler: () => () => undefined } as never, {
        handle: () => of(data),
      }),
    );
    expect(result).toEqual({ errors: null, data, message: 'Created' });
    expect(result.data).toBe(data);
  });

  it.each([new Workbook(), new StreamableFile(Buffer.from('receipt'))])(
    'does not wrap downloadable files (%#)',
    async (file) => {
      const result = await firstValueFrom(
        interceptor.intercept({ getHandler: () => () => undefined } as never, {
          handle: () => of(file),
        }),
      );
      expect(result).toBe(file);
    },
  );

  it('propagates errors to the exception filter', async () => {
    const error = new Error('upstream failure');
    await expect(
      firstValueFrom(
        interceptor.intercept({ getHandler: () => () => undefined } as never, {
          handle: () => throwError(() => error),
        }),
      ),
    ).rejects.toBe(error);
  });

  it('does not wrap server-sent events', async () => {
    const handler = () => undefined;
    Reflect.defineMetadata(SSE_METADATA, true, handler);
    const event = { type: 'heartbeat', data: { ok: true } };
    const result = await firstValueFrom(
      interceptor.intercept({ getHandler: () => handler } as never, {
        handle: () => of(event),
      }),
    );

    expect(result).toBe(event);
  });
});
