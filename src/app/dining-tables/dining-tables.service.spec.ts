import { Test, TestingModule } from '@nestjs/testing';
import { DiningTablesService } from './dining-tables.service';

describe('DiningTablesService', () => {
  let service: DiningTablesService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [DiningTablesService],
    }).compile();

    service = module.get<DiningTablesService>(DiningTablesService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });
});
