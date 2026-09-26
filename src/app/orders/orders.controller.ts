import {
  Controller,
  Get,
  Header,
  HttpCode,
  HttpStatus,
  Post,
  Body,
  Patch,
  Param,
  Delete,
  Query,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import {
  AddOrderItemsDto,
  CancelOrderItemDto,
  GetHandoffItemsDto,
  GetTakeawayFeedbackDto,
  GetTakeawayFeedbackSummaryDto,
  MergeDiningTableDto,
  OpenSessionDto,
  PickupCodeDto,
  PickupCurrentCodeDto,
  PickupHandoffDto,
  SplitOrderSessionDto,
  SubmitTakeawayFeedbackDto,
  TransferDiningTableDto,
  UpdateOrderItemStatusDto,
} from './dto';
import { OrdersService } from './orders.service';
import { IDDto } from '../../common/dto/param.dto';
import { Employee } from '../../common/decorators/employee.decorator';
import { PermissionKeys } from '../../common/consts/permission-keys';
import { RequirePermissions } from '../authorization/authorization.decorator';
import { SkipAuth } from '../auth/auth.decorator';

@Controller('orders')
export class OrdersController {
  constructor(private readonly ordersService: OrdersService) {}

  @Post('sessions')
  @RequirePermissions(PermissionKeys.ORDERS_SESSIONS_CREATE)
  openSession(
    @Employee('employeeId') employeeId: string,
    @Body() openSessionDto: OpenSessionDto,
  ) {
    return this.ordersService.openSession({
      ...openSessionDto,
      employeeId,
    });
  }

  @Get('sessions')
  @RequirePermissions(PermissionKeys.ORDERS_SESSIONS_READ)
  getActiveSessions() {
    return this.ordersService.getActiveSessions();
  }

  @Get('takeaway/handoff')
  @RequirePermissions(PermissionKeys.ORDERS_SESSIONS_READ)
  getHandoffItems(@Query() query: GetHandoffItemsDto) {
    return this.ordersService.getHandoffItems(query);
  }

  @Post('takeaway/invoices/:id/pickup-code')
  @RequirePermissions(PermissionKeys.INVOICES_READ)
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'no-store')
  issuePickupCode(
    @Param() { id }: IDDto,
    @Employee('employeeId') employeeId: string,
  ) {
    return this.ordersService.issuePickupCode(id, employeeId);
  }

  @Post('takeaway/invoices/:id/pickup-code/rotate')
  @RequirePermissions(PermissionKeys.INVOICES_UPDATE)
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'no-store')
  rotatePickupCode(
    @Param() { id }: IDDto,
    @Employee('employeeId') employeeId: string,
    @Body() { code }: PickupCurrentCodeDto,
  ) {
    return this.ordersService.rotatePickupCode(id, code, employeeId);
  }

  @Post('takeaway/invoices/:id/pickup-code/revoke')
  @RequirePermissions(PermissionKeys.INVOICES_UPDATE)
  @HttpCode(HttpStatus.OK)
  revokePickupCode(
    @Param() { id }: IDDto,
    @Employee('employeeId') employeeId: string,
    @Body() { code }: PickupCurrentCodeDto,
  ) {
    return this.ordersService.revokePickupCode(id, code, employeeId);
  }

  @Post('takeaway/pickup/status')
  @SkipAuth()
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'no-store')
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  getPickupStatus(@Body() { invoiceId, code }: PickupCodeDto) {
    return this.ordersService.getPickupStatus(invoiceId, code);
  }

  @Post('takeaway/pickup/collect')
  @RequirePermissions(PermissionKeys.ORDERS_ITEMS_HANDOFF)
  @HttpCode(HttpStatus.OK)
  handoffWithPickupCode(
    @Employee('employeeId') employeeId: string,
    @Body() { invoiceId, code, itemId }: PickupHandoffDto,
  ) {
    return this.ordersService.handoffWithPickupCode(
      invoiceId,
      code,
      itemId,
      employeeId,
    );
  }

  @Post('takeaway/pickup/feedback')
  @SkipAuth()
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'no-store')
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  submitTakeawayFeedback(@Body() dto: SubmitTakeawayFeedbackDto) {
    return this.ordersService.submitTakeawayFeedback(dto);
  }

  @Get('takeaway/feedback/summary')
  @RequirePermissions(PermissionKeys.REPORTS_READ)
  getTakeawayFeedbackSummary(@Query() query: GetTakeawayFeedbackSummaryDto) {
    return this.ordersService.getTakeawayFeedbackSummary(query);
  }

  @Get('takeaway/feedback')
  @RequirePermissions(PermissionKeys.REPORTS_READ)
  getTakeawayFeedback(@Query() query: GetTakeawayFeedbackDto) {
    return this.ordersService.getTakeawayFeedback(query);
  }

  @Get('sessions/:id')
  @RequirePermissions(PermissionKeys.ORDERS_SESSIONS_READ)
  getSessionById(@Param() { id }: IDDto) {
    return this.ordersService.getSessionById(id);
  }

  @Post('sessions/:id/items')
  @RequirePermissions(PermissionKeys.ORDERS_ITEMS_CREATE)
  addOrderItems(
    @Param() { id }: IDDto,
    @Body() addOrderItemsDto: AddOrderItemsDto,
  ) {
    return this.ordersService.addOrderItems(id, addOrderItemsDto);
  }

  @Patch('items/:id/status')
  @RequirePermissions(PermissionKeys.ORDERS_ITEMS_UPDATE_STATUS)
  updateItemStatus(
    @Param() { id }: IDDto,
    @Employee('employeeId') employeeId: string,
    @Body() updateItemStatusDto: UpdateOrderItemStatusDto,
  ) {
    return this.ordersService.updateItemStatus(
      id,
      employeeId,
      updateItemStatusDto,
    );
  }

  @Post('items/:id/handoff')
  @RequirePermissions(PermissionKeys.ORDERS_ITEMS_HANDOFF)
  handoffTakeawayItem(
    @Param() { id }: IDDto,
    @Employee('employeeId') employeeId: string,
  ) {
    return this.ordersService.handoffTakeawayItem(id, employeeId);
  }

  @Patch('items/:id/cancel')
  @RequirePermissions(PermissionKeys.ORDERS_ITEMS_CANCEL)
  cancelItem(
    @Param() { id }: IDDto,
    @Employee('employeeId') employeeId: string,
    @Body() cancelItemDto: CancelOrderItemDto,
  ) {
    return this.ordersService.cancelItem(id, employeeId, cancelItemDto);
  }

  @Delete('sessions/:id')
  @RequirePermissions(PermissionKeys.ORDERS_SESSIONS_CANCEL)
  cancelSession(@Param() { id }: IDDto) {
    return this.ordersService.cancelSession(id);
  }

  @Post('sessions/transfer-table')
  @RequirePermissions(PermissionKeys.ORDERS_TABLES_TRANSFER)
  transferTable(@Body() dto: TransferDiningTableDto) {
    return this.ordersService.transferTable(dto);
  }

  @Post('sessions/merge')
  @RequirePermissions(PermissionKeys.ORDERS_TABLES_MERGE)
  mergeTables(@Body() dto: MergeDiningTableDto) {
    return this.ordersService.mergeTables(dto);
  }

  @Post('sessions/split')
  @RequirePermissions(PermissionKeys.ORDERS_TABLES_SPLIT)
  splitTable(@Body() dto: SplitOrderSessionDto) {
    return this.ordersService.splitTable(dto);
  }

  @Post('tables/:id/clear')
  @RequirePermissions(PermissionKeys.ORDERS_TABLES_CLEAR)
  clearTable(@Param() { id }: IDDto) {
    return this.ordersService.clearTable(id);
  }
}
