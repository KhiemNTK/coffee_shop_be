import { TestingModule } from '@nestjs/testing';
import { ExcelUtilService } from './excel-util.service';
import { ExcelUtilModule } from './excel-util.module';
import { AutoMockingModule } from '../../../../test/auto-mocking/auto-mocking.module';

describe('ExcelUtilService', () => {
  let service: ExcelUtilService;

  beforeEach(async () => {
    const module: TestingModule = await AutoMockingModule.createTestingModule({
      imports: [ExcelUtilModule],
    });

    service = module.get<ExcelUtilService>(ExcelUtilService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });
});
