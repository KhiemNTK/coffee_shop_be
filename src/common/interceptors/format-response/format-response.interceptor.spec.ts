import { FormatResponseInterceptor } from './format-response.interceptor';
import { AutoMockingModule } from '../../../../test/auto-mocking/auto-mocking.module';
import { SSE_METADATA } from '@nestjs/common/constants';
import { firstValueFrom, of } from 'rxjs';

describe('FormatResponseInterceptor', () => {
  let interceptor: FormatResponseInterceptor;

  beforeEach(async () => {
    const module = await AutoMockingModule.createTestingModule({
      providers: [FormatResponseInterceptor],
    });

    interceptor = module.get<FormatResponseInterceptor>(
      FormatResponseInterceptor,
    );
  });

  it('should be defined', () => {
    expect(interceptor).toBeDefined();
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
