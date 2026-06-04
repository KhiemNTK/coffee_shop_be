import { FormatResponseInterceptor } from './format-response.interceptor';
import { AutoMockingModule } from '../../../../test/auto-mocking/auto-mocking.module';

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
});
