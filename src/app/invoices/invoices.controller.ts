import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { PermissionKeys } from '../../common/consts/permission-keys';
import { Employee } from '../../common/decorators/employee.decorator';
import { IDDto } from '../../common/dto/param.dto';
import { RequirePermissions } from '../authorization/authorization.decorator';
import {
  CheckoutInvoiceDto,
  CreateInvoiceDto,
  CreateCashRefundDto,
  GetCashRefundsDto,
  GetInvoicesPaginationDto,
  UpdateInvoicePaymentDto,
} from './dto';
import { InvoicesService } from './invoices.service';
import { CashRefundsService } from './cash-refunds.service';

@ApiTags('Invoices')
@Controller('invoices')
export class InvoicesController {
  constructor(
    private readonly invoicesService: InvoicesService,
    private readonly cashRefunds: CashRefundsService,
  ) {}

  @Post(':id/cash-refunds')
  @RequirePermissions(PermissionKeys.CASH_REFUNDS_CREATE)
  createCashRefund(
    @Param() { id }: IDDto,
    @Employee('employeeId') employeeId: string,
    @Body() dto: CreateCashRefundDto,
  ) {
    return this.cashRefunds.create(id, employeeId, dto);
  }

  @Get(':id/cash-refunds')
  @RequirePermissions(PermissionKeys.PAYMENT_REFUNDS_READ)
  findCashRefunds(@Param() { id }: IDDto, @Query() query: GetCashRefundsDto) {
    return this.cashRefunds.find(id, query);
  }

  @Post()
  @RequirePermissions(PermissionKeys.INVOICES_CREATE)
  createInvoice(
    @Employee('employeeId') employeeId: string,
    @Body() createInvoiceDto: CreateInvoiceDto,
  ) {
    return this.invoicesService.createInvoice(employeeId, createInvoiceDto);
  }

  @Post('checkout')
  @RequirePermissions(
    PermissionKeys.INVOICES_CREATE,
    PermissionKeys.INVOICES_PAY,
  )
  checkoutInvoice(
    @Employee('employeeId') employeeId: string,
    @Body() checkoutInvoiceDto: CheckoutInvoiceDto,
  ) {
    return this.invoicesService.checkoutInvoice(employeeId, checkoutInvoiceDto);
  }

  @Post('quote')
  @RequirePermissions(PermissionKeys.INVOICES_CREATE)
  quoteInvoice(
    @Employee('employeeId') employeeId: string,
    @Body() input: CreateInvoiceDto,
  ) {
    return this.invoicesService.quoteInvoice(employeeId, input);
  }

  @Get()
  @RequirePermissions(PermissionKeys.INVOICES_READ)
  getInvoices(@Query() query: GetInvoicesPaginationDto) {
    return this.invoicesService.getInvoices(query);
  }

  @Get(':id')
  @RequirePermissions(PermissionKeys.INVOICES_READ)
  getInvoiceById(@Param() { id }: IDDto) {
    return this.invoicesService.getInvoiceById(id);
  }

  @Patch(':id/payment')
  @RequirePermissions(PermissionKeys.INVOICES_PAY)
  updatePayment(
    @Param() { id }: IDDto,
    @Employee('employeeId') employeeId: string,
    @Body() updatePaymentDto: UpdateInvoicePaymentDto,
  ) {
    return this.invoicesService.updatePayment(id, employeeId, updatePaymentDto);
  }

  @Post(':id/void')
  @RequirePermissions(PermissionKeys.INVOICES_VOID)
  voidInvoice(
    @Param() { id }: IDDto,
    @Employee('employeeId') employeeId: string,
  ) {
    return this.invoicesService.voidInvoice(id, employeeId);
  }
}
