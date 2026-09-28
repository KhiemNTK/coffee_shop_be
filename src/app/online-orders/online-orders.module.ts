import { Module } from '@nestjs/common';
import { PaginationUtilModule } from '../../common/utils/pagination-util/pagination-util.module';
import { OrdersModule } from '../orders/orders.module';
import { InvoicesModule } from '../invoices/invoices.module';
import { InventoryModule } from '../inventory/inventory.module';
import { TurnstileModule } from '../auth/turnstile.module';
import { OnlineOrdersController } from './online-orders.controller';
import { OnlineOrdersService } from './online-orders.service';
import { TelegramNotificationsService } from './telegram-notifications.service';

@Module({
  imports: [
    OrdersModule,
    InvoicesModule,
    InventoryModule,
    TurnstileModule,
    PaginationUtilModule,
  ],
  controllers: [OnlineOrdersController],
  providers: [OnlineOrdersService, TelegramNotificationsService],
})
export class OnlineOrdersModule {}
