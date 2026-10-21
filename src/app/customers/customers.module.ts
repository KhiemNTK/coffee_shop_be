import { Module } from '@nestjs/common';
import { GoogleIdentityService } from '../auth/google-identity.service';
import { TurnstileModule } from '../auth/turnstile.module';
import { CustomerGuard } from './customer.guard';
import { CustomersController } from './customers.controller';
import { CustomersService } from './customers.service';
import { OnlineOrdersModule } from '../online-orders/online-orders.module';
import { CustomerOrdersController } from './customer-orders.controller';

@Module({
  imports: [TurnstileModule, OnlineOrdersModule],
  controllers: [CustomersController, CustomerOrdersController],
  providers: [CustomersService, CustomerGuard, GoogleIdentityService],
})
export class CustomersModule {}
