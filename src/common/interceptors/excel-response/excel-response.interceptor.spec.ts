import { AutoMockingModule } from '../../../../test/auto-mocking/auto-mocking.module';
import { ExcelResponseInterceptor } from './excel-response.interceptor';

describe('ExcelResponseInterceptor', () => {
  let interceptor: ExcelResponseInterceptor;

  beforeAll(async () => {
    const app = await AutoMockingModule.createTestingModule({
      providers: [ExcelResponseInterceptor],
    });

    interceptor = await app.resolve(ExcelResponseInterceptor);
  });
  it('should be defined', () => {
    expect(interceptor).toBeDefined();
  });
});
