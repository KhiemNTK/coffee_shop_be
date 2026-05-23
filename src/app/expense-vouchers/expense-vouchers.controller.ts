import { Controller, Get, Post, Body, Patch, Param, Delete } from '@nestjs/common';
import { ExpenseVouchersService } from './expense-vouchers.service';
import { CreateExpenseVoucherDto } from './dto/create-expense-voucher.dto';
import { UpdateExpenseVoucherDto } from './dto/update-expense-voucher.dto';

@Controller('expense-vouchers')
export class ExpenseVouchersController {
  constructor(private readonly expenseVouchersService: ExpenseVouchersService) {}

  @Post()
  create(@Body() createExpenseVoucherDto: CreateExpenseVoucherDto) {
    return this.expenseVouchersService.create(createExpenseVoucherDto);
  }

  @Get()
  findAll() {
    return this.expenseVouchersService.findAll();
  }

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.expenseVouchersService.findOne(+id);
  }

  @Patch(':id')
  update(@Param('id') id: string, @Body() updateExpenseVoucherDto: UpdateExpenseVoucherDto) {
    return this.expenseVouchersService.update(+id, updateExpenseVoucherDto);
  }

  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.expenseVouchersService.remove(+id);
  }
}
