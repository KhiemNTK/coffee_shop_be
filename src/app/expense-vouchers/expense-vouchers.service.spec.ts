import { Test, TestingModule } from '@nestjs/testing';
import { ExpenseVouchersService } from './expense-vouchers.service';

describe('ExpenseVouchersService', () => {
  let service: ExpenseVouchersService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [ExpenseVouchersService],
    }).compile();

    service = module.get<ExpenseVouchersService>(ExpenseVouchersService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });
});
