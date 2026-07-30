import { TestingModule } from '@nestjs/testing';
import { DiningTablesService } from './dining-tables.service';
import { AutoMockingModule } from '../../../test/auto-mocking/auto-mocking.module';
import { DiningTablesModule } from './dining-tables.module';

describe('EmployeesService', () => {
  let service: DiningTablesService;

  beforeEach(async () => {
    const module: TestingModule = await AutoMockingModule.createTestingModule({
      imports: [DiningTablesModule],
    });

    service = module.get<DiningTablesService>(DiningTablesService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });
});
