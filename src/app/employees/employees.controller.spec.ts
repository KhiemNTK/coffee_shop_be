import { TestingModule } from '@nestjs/testing';
import { EmployeesController } from './employees.controller';
import { EmployeesModule } from './employees.module';
import { AutoMockingModule } from '../../../test/auto-mocking/auto-mocking.module';

describe('EmployeesController', () => {
  let controller: EmployeesController;

  beforeEach(async () => {
    const module: TestingModule = await AutoMockingModule.createTestingModule({
      imports: [EmployeesModule],
    });

    controller = module.get<EmployeesController>(EmployeesController);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });
});
