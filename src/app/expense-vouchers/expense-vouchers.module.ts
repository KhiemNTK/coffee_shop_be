import { Module } from '@nestjs/common';
import { ExpenseVouchersService } from './expense-vouchers.service';
import { ExpenseVouchersController } from './expense-vouchers.controller';

@Module({
  controllers: [ExpenseVouchersController],
  providers: [ExpenseVouchersService],
})
export class ExpenseVouchersModule {}
