import { Module } from '@nestjs/common';
import { OrdersService } from './orders.service';
import { OrdersController } from './orders.controller';
import { OrderPolicyService } from './order-policy.service';
import { InventoryModule } from '../inventory/inventory.module';
import { CashierShiftsModule } from '../cashier-shifts/cashier-shifts.module';

@Module({
  imports: [CashierShiftsModule, InventoryModule],
  controllers: [OrdersController],
  providers: [OrdersService, OrderPolicyService],
  exports: [OrdersService, OrderPolicyService],
})
export class OrdersModule {}
