import { Module } from '@nestjs/common';
import { PaginationUtilModule } from '../../common/utils/pagination-util/pagination-util.module';
import { PrintingModule } from '../printing/printing.module';
import { KitchenController } from './kitchen.controller';
import { KitchenRealtimeService } from './kitchen-realtime.service';
import { KitchenRoutingService } from './kitchen-routing.service';
import { KitchenService } from './kitchen.service';

@Module({
  imports: [PaginationUtilModule, PrintingModule],
  controllers: [KitchenController],
  providers: [KitchenService, KitchenRoutingService, KitchenRealtimeService],
  exports: [KitchenRoutingService],
})
export class KitchenModule {}
