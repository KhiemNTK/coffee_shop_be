import {
  Body,
  Controller,
  Get,
  Header,
  Param,
  Post,
  Query,
  Req,
  Res,
  HttpCode,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { PermissionKeys } from '../../common/consts/permission-keys';
import { Employee } from '../../common/decorators/employee.decorator';
import { IDDto } from '../../common/dto/param.dto';
import type { PaymentCallbackQuery } from '../../common/types';
import { RequirePermissions } from '../authorization/authorization.decorator';
import { SkipAuth } from '../auth/auth.decorator';
import { SkipCsrf } from '../auth/csrf.decorator';
import {
  CreatePaymentAttemptDto,
  CreatePaymentRefundDto,
  GetPaymentAttemptsDto,
  GetPaymentIncidentsDto,
  GetPaymentRefundsDto,
  ResolvePaymentIncidentDto,
  PayosWebhookDto,
} from './dto';
import { PaymentReconciliationService } from './payment-reconciliation.service';
import { PaymentRefundsService } from './payment-refunds.service';
import { PaymentsService } from './payments.service';

@ApiTags('Payments')
@Controller()
export class PaymentsController {
  constructor(
    private readonly paymentsService: PaymentsService,
    private readonly refundsService: PaymentRefundsService,
    private readonly reconciliationService: PaymentReconciliationService,
  ) {}

  @Get('payments/providers')
  @RequirePermissions(PermissionKeys.PAYMENT_ATTEMPTS_READ)
  listProviders() {
    return this.paymentsService.listProviders();
  }

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

  @Post('payment-attempts/:id/payment-link')
  @RequirePermissions(
    PermissionKeys.PAYMENT_ATTEMPTS_CREATE,
    PermissionKeys.PAYMENT_ATTEMPTS_READ,
  )
  @Header('Cache-Control', 'no-store')
  recoverPaymentLink(@Param() { id }: IDDto) {
    return this.paymentsService.recoverPaymentLink(id);
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

  @Post('payments/momo/ipn')
  @SkipAuth()
  @SkipCsrf()
  @HttpCode(204)
  async handleMomoIpn(@Body() body: unknown) {
    await this.paymentsService.handleMomoIpn(body);
  }

  @Get('payments/momo/return')
  @SkipAuth()
  inspectMomoReturn(@Query() query: unknown) {
    return this.paymentsService.inspectMomoReturn(query);
  }

  @Post('payments/payos/webhook')
  @ApiOperation({
    summary: 'Verify payOS notification and durably queue reconciliation',
  })
  @SkipAuth()
  @SkipCsrf()
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  async handlePayosWebhook(@Body() body: PayosWebhookDto) {
    await this.paymentsService.handlePayosWebhook(body);
    return { ok: true };
  }

  @Get('payments/payos/return')
  @ApiOperation({
    summary:
      'Read payment status with a server-issued return token; never confirms payment',
  })
  @SkipAuth()
  @Header('Cache-Control', 'no-store')
  inspectPayosReturn(@Query() query: PaymentCallbackQuery) {
    return this.paymentsService.inspectPayosReturn(query);
  }
}
