import { Module } from '@nestjs/common';
import { PaginationUtilModule } from '../../common/utils/pagination-util/pagination-util.module';
import { OrdersModule } from '../orders/orders.module';
import { OnlineOrdersController } from './online-orders.controller';
import { OnlineOrdersService } from './online-orders.service';

@Module({
  imports: [OrdersModule, PaginationUtilModule],
  controllers: [OnlineOrdersController],
  providers: [OnlineOrdersService],
})
export class OnlineOrdersModule {}
