import {
  Body,
  ConflictException,
  Controller,
  Get,
  Header,
  HttpCode,
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
import type { CustomerRequest } from '../../common/types';
import { SkipAuth } from '../auth/auth.decorator';
import { CustomerGuard } from '../customers/customer.guard';
import {
  ClaimCustomerVoucherDto,
  GetCustomerVouchersDto,
} from './dto/voucher.dto';
import { VouchersService } from './vouchers.service';

@ApiTags('Customer Vouchers')
@ApiCookieAuth(CUSTOMER_SESSION_COOKIE)
@Controller('customers/vouchers')
@SkipAuth()
@SetMetadata(CUSTOMER_AUTH_SCOPE, true)
@UseGuards(CustomerGuard)
export class CustomerVouchersController {
  constructor(private readonly vouchers: VouchersService) {}

  @Get()
  @Header('Cache-Control', 'no-store')
  getWallet(
    @Req() request: CustomerRequest,
    @Query() query: GetCustomerVouchersDto,
  ) {
    return this.vouchers.getWallet(request.customer.id, query);
  }

  @Post('claim')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  claim(@Req() request: CustomerRequest, @Body() dto: ClaimCustomerVoucherDto) {
    if (request.customer.id !== dto.expectedCustomerId)
      throw new ConflictException({
        code: 'CUSTOMER_SESSION_CHANGED',
        message: 'Customer account changed. Reload before retrying.',
      });
    return this.vouchers.claim(request.customer.id, dto.campaignId);
  }
}
