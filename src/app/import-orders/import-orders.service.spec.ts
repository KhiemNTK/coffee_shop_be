import { Test, TestingModule } from '@nestjs/testing';
import { ImportOrdersService } from './import-orders.service';

describe('ImportOrdersService', () => {
  let service: ImportOrdersService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [ImportOrdersService],
    }).compile();

    service = module.get<ImportOrdersService>(ImportOrdersService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });
});
