import { Module } from '@nestjs/common';
import { OrdersService } from './orders.service';
import { OrdersController } from './orders.controller';
import { OrderEventsPublisher } from './events/order-events.publisher';
import { OrderPolicyService } from './order-policy.service';

@Module({
  controllers: [OrdersController],
  providers: [OrdersService, OrderEventsPublisher, OrderPolicyService],
  exports: [OrdersService, OrderEventsPublisher, OrderPolicyService],
})
export class OrdersModule {}
