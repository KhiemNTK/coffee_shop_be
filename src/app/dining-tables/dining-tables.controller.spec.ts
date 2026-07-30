import { TestingModule } from '@nestjs/testing';
import { DiningTablesController } from './dining-tables.controller';
import { DiningTablesModule } from './dining-tables.module';
import { AutoMockingModule } from '../../../test/auto-mocking/auto-mocking.module';

describe('EmployeesController', () => {
  let controller: DiningTablesController;

  beforeEach(async () => {
    const module: TestingModule = await AutoMockingModule.createTestingModule({
      imports: [DiningTablesModule],
    });

    controller = module.get<DiningTablesController>(DiningTablesController);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });
});
