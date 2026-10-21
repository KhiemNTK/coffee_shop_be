import {
  Body,
  ConflictException,
  Controller,
  Get,
  Header,
  Param,
  Post,
  Query,
  Req,
  SetMetadata,
  UseGuards,
} from '@nestjs/common';
import { ApiCookieAuth, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import {
  CUSTOMER_AUTH_SCOPE,
  CUSTOMER_SESSION_COOKIE,
} from '../../common/consts/customer-auth';
import { IDDto } from '../../common/dto/param.dto';
import type { CustomerRequest } from '../../common/types';
import { SkipAuth } from '../auth/auth.decorator';
import { OnlineOrdersService } from '../online-orders/online-orders.service';
import { CustomerGuard } from './customer.guard';
import { CreateCustomerOrderDto, GetCustomerOrdersDto } from './customer.dto';

@ApiTags('Customer Orders')
@ApiCookieAuth(CUSTOMER_SESSION_COOKIE)
@Controller('customers/orders')
@SkipAuth()
@SetMetadata(CUSTOMER_AUTH_SCOPE, true)
@UseGuards(CustomerGuard)
export class CustomerOrdersController {
  constructor(private readonly onlineOrders: OnlineOrdersService) {}

  @Post()
  @Header('Cache-Control', 'no-store')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  create(@Req() request: CustomerRequest, @Body() dto: CreateCustomerOrderDto) {
    if (request.customer.id !== dto.expectedCustomerId)
      throw new ConflictException({
        code: 'CUSTOMER_SESSION_CHANGED',
        message: 'Customer account changed. Reload before retrying.',
      });
    return this.onlineOrders.createPublicRequest(
      dto,
      request.ip,
      request.customer.id,
    );
  }

  @Get()
  @Header('Cache-Control', 'no-store')
  async getOrders(
    @Req() request: CustomerRequest,
    @Query() query: GetCustomerOrdersDto,
  ) {
    return {
      ...(await this.onlineOrders.getCustomerOrders(
        request.customer.id,
        query,
      )),
      customerId: request.customer.id,
    };
  }

  @Get(':id/reorder-template')
  @Header('Cache-Control', 'no-store')
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  async reorderTemplate(
    @Req() request: CustomerRequest,
    @Param() { id }: IDDto,
  ) {
    return {
      ...(await this.onlineOrders.customerReorderTemplate(
        request.customer.id,
        id,
      )),
      customerId: request.customer.id,
    };
  }

  @Get(':id')
  @Header('Cache-Control', 'no-store')
  async getOrder(@Req() request: CustomerRequest, @Param() { id }: IDDto) {
    return {
      ...(await this.onlineOrders.getCustomerOrder(request.customer.id, id)),
      customerId: request.customer.id,
    };
  }
}
