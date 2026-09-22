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
import {
  CreatePaymentAttemptDto,
  CreatePaymentRefundDto,
  GetPaymentAttemptsDto,
  GetPaymentIncidentsDto,
  GetPaymentRefundsDto,
  ResolvePaymentIncidentDto,
} from './dto';
import { PaymentReconciliationService } from './payment-reconciliation.service';
import { PaymentRefundsService } from './payment-refunds.service';
import { PaymentsService } from './payments.service';

@ApiTags('payments')
@Controller()
export class PaymentsController {
  constructor(
    private readonly paymentsService: PaymentsService,
    private readonly refundsService: PaymentRefundsService,
    private readonly reconciliationService: PaymentReconciliationService,
  ) {}

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

  @Post('payment-attempts/:id/refunds')
  @RequirePermissions(PermissionKeys.PAYMENT_REFUNDS_CREATE)
  createRefund(
    @Param() { id }: IDDto,
    @Employee('employeeId') employeeId: string,
    @Body() dto: CreatePaymentRefundDto,
  ) {
    return this.refundsService.createRefund(id, employeeId, dto);
  }

  @Get('payment-attempts/:id/refunds')
  @RequirePermissions(PermissionKeys.PAYMENT_REFUNDS_READ)
  findRefunds(@Param() { id }: IDDto, @Query() query: GetPaymentRefundsDto) {
    return this.refundsService.findRefunds(id, query);
  }

  @Get('payment-refunds/:id')
  @RequirePermissions(PermissionKeys.PAYMENT_REFUNDS_READ)
  findRefund(@Param() { id }: IDDto) {
    return this.refundsService.findRefund(id);
  }

  @Post('payment-attempts/:id/reconcile')
  @RequirePermissions(PermissionKeys.PAYMENT_RECONCILIATION_MANAGE)
  reconcileAttempt(
    @Param() { id }: IDDto,
    @Employee('employeeId') employeeId: string,
  ) {
    return this.reconciliationService.reconcileAttempt(id, employeeId);
  }

  @Get('payment-reconciliation/incidents')
  @RequirePermissions(PermissionKeys.PAYMENT_RECONCILIATION_READ)
  findIncidents(@Query() query: GetPaymentIncidentsDto) {
    return this.reconciliationService.findIncidents(query);
  }

  @Post('payment-reconciliation/incidents/:id/resolve')
  @RequirePermissions(PermissionKeys.PAYMENT_RECONCILIATION_MANAGE)
  resolveIncident(
    @Param() { id }: IDDto,
    @Employee('employeeId') employeeId: string,
    @Body() dto: ResolvePaymentIncidentDto,
  ) {
    return this.reconciliationService.resolveIncident(id, employeeId, dto);
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
