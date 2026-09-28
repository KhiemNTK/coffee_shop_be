import {
  Body,
  Controller,
  Get,
  Header,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { PermissionKeys } from '../../common/consts/permission-keys';
import { Employee } from '../../common/decorators/employee.decorator';
import { IDDto } from '../../common/dto/param.dto';
import { RequirePermissions } from '../authorization/authorization.decorator';
import { SkipAuth } from '../auth/auth.decorator';
import {
  CreateOnlineOrderDto,
  CancelAcceptedOnlineOrderDto,
  CollectOnlineOrderDto,
  GetPendingOnlineOrdersDto,
  GetPickupSlotsDto,
  OnlineOrderAccessDto,
  ReorderTemplateDto,
  RejectOnlineOrderDto,
  RevokeReorderKeyDto,
} from './dto';
import { OnlineOrdersService } from './online-orders.service';
import { TelegramNotificationsService } from './telegram-notifications.service';

@ApiTags('Online Orders')
@Controller('online-orders')
export class OnlineOrdersController {
  constructor(
    private readonly onlineOrders: OnlineOrdersService,
    private readonly telegram: TelegramNotificationsService,
  ) {}

  @Post('telegram/webhook')
  @SkipAuth()
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 120, ttl: 60_000 } })
  receiveTelegramWebhook(
    @Headers('x-telegram-bot-api-secret-token') secret: string | undefined,
    @Body() body: unknown,
  ) {
    return this.telegram.receiveWebhook(secret, body);
  }

  @Get('pickup-slots')
  @SkipAuth()
  @Header('Cache-Control', 'no-store')
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  getPickupSlots(@Query() { date }: GetPickupSlotsDto) {
    return this.onlineOrders.getPickupSlots(date);
  }

  @Post('requests')
  @SkipAuth()
  @Header('Cache-Control', 'no-store')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  createRequest(@Body() dto: CreateOnlineOrderDto) {
    return this.onlineOrders.createPublicRequest(dto);
  }

  @Post('requests/status')
  @SkipAuth()
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'no-store')
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  trackRequest(@Body() dto: OnlineOrderAccessDto) {
    return this.onlineOrders.trackPublicRequest(dto);
  }

  @Post('requests/reorder-template')
  @SkipAuth()
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'no-store')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  reorderTemplate(@Body() dto: ReorderTemplateDto) {
    return this.onlineOrders.reorderTemplate(dto);
  }

  @Post('requests/reorder-key')
  @SkipAuth()
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'no-store')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  issueReorderKey(@Body() dto: OnlineOrderAccessDto) {
    return this.onlineOrders.issueReorderKey(dto);
  }

  @Post('requests/reorder-key/revoke')
  @SkipAuth()
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'no-store')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  revokeReorderKey(@Body() dto: RevokeReorderKeyDto) {
    return this.onlineOrders.revokeReorderKey(dto);
  }

  @Post('requests/telegram-link')
  @SkipAuth()
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'no-store')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  createTelegramLink(@Body() dto: OnlineOrderAccessDto) {
    return this.onlineOrders.createTelegramLink(dto);
  }

  @Post('requests/cancel')
  @SkipAuth()
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'no-store')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  cancelRequest(@Body() dto: OnlineOrderAccessDto) {
    return this.onlineOrders.cancelPublicRequest(dto);
  }

  @Get('requests')
  @RequirePermissions(PermissionKeys.ONLINE_ORDERS_READ)
  @Header('Cache-Control', 'no-store')
  findPending(@Query() query: GetPendingOnlineOrdersDto) {
    return this.onlineOrders.findPending(query);
  }

  @Get('requests/fulfillment')
  @RequirePermissions(PermissionKeys.ONLINE_ORDERS_READ)
  @Header('Cache-Control', 'no-store')
  findFulfillment(@Query() query: GetPendingOnlineOrdersDto) {
    return this.onlineOrders.findFulfillment(query);
  }

  @Get('requests/:id')
  @RequirePermissions(PermissionKeys.ONLINE_ORDERS_READ)
  @Header('Cache-Control', 'no-store')
  findOne(@Param() { id }: IDDto) {
    return this.onlineOrders.findOne(id);
  }

  @Post('requests/:id/accept')
  @RequirePermissions(PermissionKeys.ONLINE_ORDERS_REVIEW)
  accept(@Param() { id }: IDDto, @Employee('employeeId') employeeId: string) {
    return this.onlineOrders.accept(id, employeeId);
  }

  @Post('requests/:id/reject')
  @RequirePermissions(PermissionKeys.ONLINE_ORDERS_REVIEW)
  reject(
    @Param() { id }: IDDto,
    @Employee('employeeId') employeeId: string,
    @Body() { reason }: RejectOnlineOrderDto,
  ) {
    return this.onlineOrders.reject(id, employeeId, reason);
  }

  @Post('requests/:id/collect')
  @RequirePermissions(
    PermissionKeys.INVOICES_CREATE,
    PermissionKeys.ORDERS_ITEMS_HANDOFF,
  )
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'no-store')
  collect(
    @Param() { id }: IDDto,
    @Employee('employeeId') employeeId: string,
    @Body() dto: CollectOnlineOrderDto,
  ) {
    return this.onlineOrders.collect(id, employeeId, dto);
  }

  @Post('requests/:id/cancel')
  @RequirePermissions(PermissionKeys.ONLINE_ORDERS_REVIEW)
  @HttpCode(HttpStatus.OK)
  cancelAccepted(
    @Param() { id }: IDDto,
    @Employee('employeeId') employeeId: string,
    @Body() { reason }: CancelAcceptedOnlineOrderDto,
  ) {
    return this.onlineOrders.cancelAccepted(id, employeeId, reason);
  }

  @Post('requests/:id/no-show')
  @RequirePermissions(PermissionKeys.ONLINE_ORDERS_REVIEW)
  @HttpCode(HttpStatus.OK)
  markNoShow(
    @Param() { id }: IDDto,
    @Employee('employeeId') employeeId: string,
  ) {
    return this.onlineOrders.markNoShow(id, employeeId);
  }
}
