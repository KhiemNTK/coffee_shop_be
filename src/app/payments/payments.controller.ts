import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { PermissionKeys } from '../../common/consts/permission-keys';
import { Employee } from '../../common/decorators/employee.decorator';
import { IDDto } from '../../common/dto/param.dto';
import type { PaymentCallbackQuery } from '../../common/types';
import { RequirePermissions } from '../authorization/authorization.decorator';
import { SkipAuth } from '../auth/auth.decorator';
import { CreatePaymentAttemptDto, GetPaymentAttemptsDto } from './dto';
import { PaymentsService } from './payments.service';

@ApiTags('payments')
@Controller()
export class PaymentsController {
  constructor(private readonly paymentsService: PaymentsService) {}

  @Post('invoices/:id/payment-attempts')
  @RequirePermissions(PermissionKeys.PAYMENT_ATTEMPTS_CREATE)
  createAttempt(
    @Param() { id }: IDDto,
    @Employee('employeeId') employeeId: string,
    @Req() request: Request,
    @Body() dto: CreatePaymentAttemptDto,
  ) {
    return this.paymentsService.createAttempt(
      id,
      employeeId,
      request.ip || request.socket.remoteAddress || '127.0.0.1',
      dto,
    );
  }

  @Get('invoices/:id/payment-attempts')
  @RequirePermissions(PermissionKeys.PAYMENT_ATTEMPTS_READ)
  findAttempts(@Param() { id }: IDDto, @Query() query: GetPaymentAttemptsDto) {
    return this.paymentsService.findAttempts(id, query);
  }

  @Get('payment-attempts/:id')
  @RequirePermissions(PermissionKeys.PAYMENT_ATTEMPTS_READ)
  findAttempt(@Param() { id }: IDDto) {
    return this.paymentsService.findAttempt(id);
  }

  @Get('payments/vnpay/ipn')
  @SkipAuth()
  async handleVnpayIpn(
    @Query() query: PaymentCallbackQuery,
    @Res() response: Response,
  ) {
    const result = await this.paymentsService.handleVnpayIpn(query);
    response.status(200).json(result);
  }

  @Get('payments/vnpay/return')
  @SkipAuth()
  inspectVnpayReturn(@Query() query: PaymentCallbackQuery) {
    return this.paymentsService.inspectVnpayReturn(query);
  }
}
