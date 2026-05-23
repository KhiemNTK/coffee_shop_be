import { Test, TestingModule } from '@nestjs/testing';
import { DiningTablesController } from './dining-tables.controller';
import { DiningTablesService } from './dining-tables.service';

describe('DiningTablesController', () => {
  let controller: DiningTablesController;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [DiningTablesController],
      providers: [DiningTablesService],
    }).compile();

    controller = module.get<DiningTablesController>(DiningTablesController);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });
});
