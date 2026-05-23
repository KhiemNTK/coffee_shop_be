import { Test, TestingModule } from '@nestjs/testing';
import { ExportOrdersController } from './export-orders.controller';
import { ExportOrdersService } from './export-orders.service';

describe('ExportOrdersController', () => {
  let controller: ExportOrdersController;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [ExportOrdersController],
      providers: [ExportOrdersService],
    }).compile();

    controller = module.get<ExportOrdersController>(ExportOrdersController);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });
});
