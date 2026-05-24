import { Test, TestingModule } from '@nestjs/testing';
import { ExpenseVouchersController } from './expense-vouchers.controller';
import { ExpenseVouchersService } from './expense-vouchers.service';

describe('ExpenseVouchersController', () => {
  let controller: ExpenseVouchersController;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [ExpenseVouchersController],
      providers: [ExpenseVouchersService],
    }).compile();

    controller = module.get<ExpenseVouchersController>(
      ExpenseVouchersController,
    );
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });
});
