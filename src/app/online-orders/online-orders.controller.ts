import {
  Body,
  Controller,
  Get,
  Header,
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
  GetPendingOnlineOrdersDto,
  OnlineOrderAccessDto,
  RejectOnlineOrderDto,
} from './dto';
import { OnlineOrdersService } from './online-orders.service';

@ApiTags('Online Orders')
@Controller('online-orders')
export class OnlineOrdersController {
  constructor(private readonly onlineOrders: OnlineOrdersService) {}

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
  findPending(@Query() query: GetPendingOnlineOrdersDto) {
    return this.onlineOrders.findPending(query);
  }

  @Get('requests/:id')
  @RequirePermissions(PermissionKeys.ONLINE_ORDERS_READ)
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
}
