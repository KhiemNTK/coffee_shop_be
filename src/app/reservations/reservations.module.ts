import { Module } from '@nestjs/common';
import { ReservationsService } from './reservations.service';
import { ReservationsController } from './reservations.controller';
import { PaginationUtilModule } from '../../common/utils/pagination-util/pagination-util.module';
import { OrdersModule } from '../orders/orders.module';
import { TurnstileModule } from '../auth/turnstile.module';

@Module({
  imports: [PaginationUtilModule, OrdersModule, TurnstileModule],
  controllers: [ReservationsController],
  providers: [ReservationsService],
})
export class ReservationsModule {}
