import { Test, TestingModule } from '@nestjs/testing';
import { ImportOrdersController } from './import-orders.controller';
import { ImportOrdersService } from './import-orders.service';

describe('ImportOrdersController', () => {
  let controller: ImportOrdersController;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [ImportOrdersController],
      providers: [ImportOrdersService],
    }).compile();

    controller = module.get<ImportOrdersController>(ImportOrdersController);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });
});
