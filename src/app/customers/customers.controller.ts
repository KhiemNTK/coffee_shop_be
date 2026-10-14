import {
  Body,
  ConflictException,
  Controller,
  Delete,
  Get,
  Header,
  HttpCode,
  Param,
  Post,
  Put,
  Req,
  Res,
  SetMetadata,
  UseGuards,
} from '@nestjs/common';
import { ApiCookieAuth, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import {
  CUSTOMER_AUTH_SCOPE,
  CUSTOMER_CSRF_COOKIE,
  CUSTOMER_PUBLIC_ROUTE,
  CUSTOMER_SESSION_COOKIE,
  CUSTOMER_SESSION_TTL_MS,
} from '../../common/consts/customer-auth';
import {
  createCsrfToken,
  getAuthCookieOptions,
  getCsrfCookieOptions,
} from '../../common/decorators/cookie/cookie.const';
import { IDDto } from '../../common/dto/param.dto';
import type { CustomerRequest } from '../../common/types';
import { SkipAuth } from '../auth/auth.decorator';
import { SkipCsrf } from '../auth/csrf.decorator';
import { GoogleSignInDto } from '../auth/dto';
import { CustomerGuard } from './customer.guard';
import { CustomersService } from './customers.service';
import { ExpectedCustomerDto } from './customer.dto';

@ApiTags('Customers')
@Controller('customers')
@SkipAuth()
@SetMetadata(CUSTOMER_AUTH_SCOPE, true)
@UseGuards(CustomerGuard)
export class CustomersController {
  constructor(private readonly customers: CustomersService) {}

  @Post('auth/google')
  @SetMetadata(CUSTOMER_PUBLIC_ROUTE, true)
  @Header('Cache-Control', 'no-store')
  @SkipCsrf()
  @HttpCode(200)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  async signIn(
    @Body() dto: GoogleSignInDto,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    const result = await this.customers.signIn(
      dto.idToken,
      dto.turnstileToken,
      request.ip,
      request.cookies?.[CUSTOMER_SESSION_COOKIE],
    );
    response.cookie(CUSTOMER_SESSION_COOKIE, result.token, {
      ...getAuthCookieOptions(),
      maxAge: CUSTOMER_SESSION_TTL_MS,
    });
    this.ensureCsrf(request, response);
    return { customer: result.customer };
  }

  @Get('me')
  @Header('Cache-Control', 'no-store')
  @ApiCookieAuth(CUSTOMER_SESSION_COOKIE)
  me(
    @Req() request: CustomerRequest,
    @Res({ passthrough: true }) response: Response,
  ) {
    this.ensureCsrf(request, response);
    return request.customer;
  }

  @Post('auth/logout')
  @SetMetadata(CUSTOMER_PUBLIC_ROUTE, true)
  @Header('Cache-Control', 'no-store')
  @HttpCode(200)
  async logout(
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    const result = await this.customers.logout(
      request.cookies?.[CUSTOMER_SESSION_COOKIE],
    );
    response.clearCookie(CUSTOMER_SESSION_COOKIE, getAuthCookieOptions());
    response.clearCookie(CUSTOMER_CSRF_COOKIE, getCsrfCookieOptions());
    return result;
  }

  @Get('wishlist')
  @Header('Cache-Control', 'no-store')
  @ApiCookieAuth(CUSTOMER_SESSION_COOKIE)
  getWishlist(@Req() request: CustomerRequest) {
    return this.customers.getWishlist(request.customer.id);
  }

  @Put('wishlist/:id')
  @Header('Cache-Control', 'no-store')
  @ApiCookieAuth(CUSTOMER_SESSION_COOKIE)
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  addFavorite(
    @Req() request: CustomerRequest,
    @Param() { id }: IDDto,
    @Body() dto: ExpectedCustomerDto,
  ) {
    this.assertCustomer(request, dto);
    return this.customers.addFavorite(request.customer.id, id);
  }

  @Delete('wishlist/:id')
  @Header('Cache-Control', 'no-store')
  @ApiCookieAuth(CUSTOMER_SESSION_COOKIE)
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  removeFavorite(
    @Req() request: CustomerRequest,
    @Param() { id }: IDDto,
    @Body() dto: ExpectedCustomerDto,
  ) {
    this.assertCustomer(request, dto);
    return this.customers.removeFavorite(request.customer.id, id);
  }

  private ensureCsrf(request: Request, response: Response) {
    const token: unknown = request.cookies?.[CUSTOMER_CSRF_COOKIE];
    if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(token))
      response.cookie(CUSTOMER_CSRF_COOKIE, createCsrfToken(), {
        ...getCsrfCookieOptions(),
        maxAge: CUSTOMER_SESSION_TTL_MS,
      });
  }

  private assertCustomer(request: CustomerRequest, dto: ExpectedCustomerDto) {
    if (request.customer.id !== dto.expectedCustomerId)
      throw new ConflictException({
        code: 'CUSTOMER_SESSION_CHANGED',
        message: 'Customer account changed. Reload before retrying.',
      });
  }
}
