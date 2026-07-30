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
import { CheckoutInvoiceDto, CreateInvoiceDto } from './dto/create-invoice.dto';
import { GetInvoicesPaginationDto } from './dto/get-invoice.dto';
import { UpdateInvoicePaymentDto } from './dto/update-invoice.dto';
import { InvoicesService } from './invoices.service';

@ApiTags('invoices')
@Controller('invoices')
export class InvoicesController {
  constructor(private readonly invoicesService: InvoicesService) {}

  @Post()
  @RequirePermissions(PermissionKeys.INVOICES_CREATE)
  createInvoice(
    @Employee('employeeId') employeeId: string,
    @Body() createInvoiceDto: CreateInvoiceDto,
  ) {
    return this.invoicesService.createInvoice(employeeId, createInvoiceDto);
  }

  @Post('checkout')
  @RequirePermissions(PermissionKeys.INVOICES_CREATE)
  checkoutInvoice(
    @Employee('employeeId') employeeId: string,
    @Body() checkoutInvoiceDto: CheckoutInvoiceDto,
  ) {
    return this.invoicesService.checkoutInvoice(employeeId, checkoutInvoiceDto);
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
  @RequirePermissions(PermissionKeys.INVOICES_UPDATE)
  updatePayment(
    @Param() { id }: IDDto,
    @Employee('employeeId') employeeId: string,
    @Body() updatePaymentDto: UpdateInvoicePaymentDto,
  ) {
    return this.invoicesService.updatePayment(id, employeeId, updatePaymentDto);
  }

  @Post(':id/void')
  @RequirePermissions(PermissionKeys.INVOICES_UPDATE)
  voidInvoice(
    @Param() { id }: IDDto,
    @Employee('employeeId') employeeId: string,
  ) {
    return this.invoicesService.voidInvoice(id, employeeId);
  }
}
