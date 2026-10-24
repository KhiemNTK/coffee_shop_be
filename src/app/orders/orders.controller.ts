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
  CancelSessionDto,
  ClearDiningTableDto,
  RemakeOrderItemDto,
  GetHandoffItemsDto,
  GetOpenTakeawayFeedbackCasesDto,
  GetTakeawayFeedbackDto,
  GetTakeawayFeedbackSummaryDto,
  MergeDiningTableDto,
  OpenSessionDto,
  PickupCodeDto,
  PickupCurrentCodeDto,
  PickupHandoffDto,
  ResolveTakeawayFeedbackDto,
  SplitOrderSessionDto,
  SubmitTakeawayFeedbackDto,
  TransferDiningTableDto,
  UpdateOrderItemStatusDto,
} from './dto';
import { OrdersService } from './orders.service';
import { TakeawayService } from './takeaway.service';
import { IDDto } from '../../common/dto/param.dto';
import { Employee } from '../../common/decorators/employee.decorator';
import { PermissionKeys } from '../../common/consts/permission-keys';
import { RequirePermissions } from '../authorization/authorization.decorator';
import { SkipAuth } from '../auth/auth.decorator';
import { ApiTags } from '@nestjs/swagger';

@ApiTags('Orders')
@Controller('orders')
export class OrdersController {
  constructor(
    private readonly ordersService: OrdersService,
    private readonly takeaway: TakeawayService,
  ) {}

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
    return this.takeaway.issuePickupCode(id, employeeId);
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
    return this.takeaway.rotatePickupCode(id, code, employeeId);
  }

  @Post('takeaway/invoices/:id/pickup-code/revoke')
  @RequirePermissions(PermissionKeys.INVOICES_UPDATE)
  @HttpCode(HttpStatus.OK)
  revokePickupCode(
    @Param() { id }: IDDto,
    @Employee('employeeId') employeeId: string,
    @Body() { code }: PickupCurrentCodeDto,
  ) {
    return this.takeaway.revokePickupCode(id, code, employeeId);
  }

  @Post('takeaway/pickup/status')
  @SkipAuth()
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'no-store')
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  getPickupStatus(@Body() { invoiceId, code }: PickupCodeDto) {
    return this.takeaway.getPickupStatus(invoiceId, code);
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
    return this.takeaway.submitTakeawayFeedback(dto);
  }

  @Get('takeaway/feedback/summary')
  @RequirePermissions(PermissionKeys.REPORTS_READ)
  getTakeawayFeedbackSummary(@Query() query: GetTakeawayFeedbackSummaryDto) {
    return this.takeaway.getTakeawayFeedbackSummary(query);
  }

  @Get('takeaway/feedback/cases')
  @RequirePermissions(PermissionKeys.REPORTS_READ)
  getOpenTakeawayFeedbackCases(
    @Query() query: GetOpenTakeawayFeedbackCasesDto,
  ) {
    return this.takeaway.getOpenTakeawayFeedbackCases(query);
  }

  @Post('takeaway/feedback/:id/resolve')
  @RequirePermissions(PermissionKeys.FEEDBACK_RESOLVE)
  @HttpCode(HttpStatus.OK)
  resolveTakeawayFeedback(
    @Param() { id }: IDDto,
    @Employee('employeeId') employeeId: string,
    @Body() dto: ResolveTakeawayFeedbackDto,
  ) {
    return this.takeaway.resolveTakeawayFeedback(id, employeeId, dto);
  }

  @Get('takeaway/feedback')
  @RequirePermissions(PermissionKeys.REPORTS_READ)
  getTakeawayFeedback(@Query() query: GetTakeawayFeedbackDto) {
    return this.takeaway.getTakeawayFeedback(query);
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
    @Employee('employeeId') employeeId: string,
  ) {
    return this.ordersService.addOrderItems(id, addOrderItemsDto, employeeId);
  }

  @Post('sessions/:id/complete')
  @RequirePermissions(PermissionKeys.ORDERS_TABLES_CLEAR)
  @HttpCode(HttpStatus.OK)
  completeSession(
    @Param() { id }: IDDto,
    @Employee('employeeId') employeeId: string,
  ) {
    return this.ordersService.completeSession(id, employeeId);
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

  @Post('items/:id/remake')
  @RequirePermissions(PermissionKeys.ORDERS_ITEMS_REMAKE)
  remakeItem(
    @Param() { id }: IDDto,
    @Employee('employeeId') employeeId: string,
    @Body() dto: RemakeOrderItemDto,
  ) {
    return this.ordersService.remakeItem(id, employeeId, dto);
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
  cancelSession(
    @Param() { id }: IDDto,
    @Employee('employeeId') employeeId: string,
    @Body() dto: CancelSessionDto,
  ) {
    return this.ordersService.cancelSession(id, employeeId, dto.reason);
  }

  @Post('sessions/transfer-table')
  @RequirePermissions(PermissionKeys.ORDERS_TABLES_TRANSFER)
  transferTable(
    @Body() dto: TransferDiningTableDto,
    @Employee('employeeId') employeeId: string,
  ) {
    return this.ordersService.transferTable(dto, employeeId);
  }

  @Post('sessions/merge')
  @RequirePermissions(PermissionKeys.ORDERS_TABLES_MERGE)
  mergeTables(
    @Body() dto: MergeDiningTableDto,
    @Employee('employeeId') employeeId: string,
  ) {
    return this.ordersService.mergeTables(dto, employeeId);
  }

  @Post('sessions/split')
  @RequirePermissions(PermissionKeys.ORDERS_TABLES_SPLIT)
  splitTable(
    @Body() dto: SplitOrderSessionDto,
    @Employee('employeeId') employeeId: string,
  ) {
    return this.ordersService.splitTable(dto, employeeId);
  }

  @Post('tables/:id/clear')
  @RequirePermissions(PermissionKeys.ORDERS_TABLES_CLEAR)
  clearTable(
    @Param() { id }: IDDto,
    @Body() dto: ClearDiningTableDto,
    @Employee('employeeId') employeeId: string,
  ) {
    return this.ordersService.clearTable(
      id,
      dto.expectedOrderSessionId,
      employeeId,
      dto.reason,
    );
  }
}
