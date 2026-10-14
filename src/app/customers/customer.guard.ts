import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import {
  CUSTOMER_PUBLIC_ROUTE,
  CUSTOMER_SESSION_COOKIE,
} from '../../common/consts/customer-auth';
import type { CustomerRequest } from '../../common/types';
import { CustomersService } from './customers.service';

@Injectable()
export class CustomerGuard implements CanActivate {
  constructor(
    private readonly customers: CustomersService,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext) {
    if (
      this.reflector.getAllAndOverride<boolean>(CUSTOMER_PUBLIC_ROUTE, [
        context.getHandler(),
        context.getClass(),
      ])
    )
      return true;
    const request = context.switchToHttp().getRequest<CustomerRequest>();
    request.customer = await this.customers.authenticate(
      request.cookies?.[CUSTOMER_SESSION_COOKIE],
    );
    return true;
  }
}
