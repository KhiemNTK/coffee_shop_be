import { Test, TestingModule } from '@nestjs/testing';
import { ExportOrdersService } from './export-orders.service';

describe('ExportOrdersService', () => {
  let service: ExportOrdersService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [ExportOrdersService],
    }).compile();

    service = module.get<ExportOrdersService>(ExportOrdersService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });
});
