import { Injectable } from '@nestjs/common';
import { CreateExpenseVoucherDto } from './dto/create-expense-voucher.dto';
import { UpdateExpenseVoucherDto } from './dto/update-expense-voucher.dto';

@Injectable()
export class ExpenseVouchersService {
  create(createExpenseVoucherDto: CreateExpenseVoucherDto) {
    return 'This action adds a new expenseVoucher';
  }

  findAll() {
    return `This action returns all expenseVouchers`;
  }

  findOne(id: number) {
    return `This action returns a #${id} expenseVoucher`;
  }

  update(id: number, updateExpenseVoucherDto: UpdateExpenseVoucherDto) {
    return `This action updates a #${id} expenseVoucher`;
  }

  remove(id: number) {
    return `This action removes a #${id} expenseVoucher`;
  }
}
