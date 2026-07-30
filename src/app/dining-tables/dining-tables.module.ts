import { Module } from '@nestjs/common';
import { DiningTablesService } from './dining-tables.service';
import { DiningTablesController } from './dining-tables.controller';
import { PaginationUtilService } from '../../common/utils/pagination-util/pagination-util.service';
import { OrdersModule } from '../orders/orders.module';

@Module({
  imports: [OrdersModule],
  controllers: [DiningTablesController],
  providers: [DiningTablesService, PaginationUtilService],
  exports: [DiningTablesService],
})
export class DiningTablesModule {}
