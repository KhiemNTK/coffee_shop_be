import { TestingModule } from '@nestjs/testing';
import { EmployeesService } from './employees.service';
import { AutoMockingModule } from '../../../test/auto-mocking/auto-mocking.module';
import { EmployeesModule } from './employees.module';

describe('EmployeesService', () => {
  let service: EmployeesService;

  beforeEach(async () => {
    const module: TestingModule = await AutoMockingModule.createTestingModule({
      imports: [EmployeesModule],
    });

    service = module.get<EmployeesService>(EmployeesService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });
});
