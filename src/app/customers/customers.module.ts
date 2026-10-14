import { Module } from '@nestjs/common';
import { GoogleIdentityService } from '../auth/google-identity.service';
import { TurnstileModule } from '../auth/turnstile.module';
import { CustomerGuard } from './customer.guard';
import { CustomersController } from './customers.controller';
import { CustomersService } from './customers.service';

@Module({
  imports: [TurnstileModule],
  controllers: [CustomersController],
  providers: [CustomersService, CustomerGuard, GoogleIdentityService],
})
export class CustomersModule {}
