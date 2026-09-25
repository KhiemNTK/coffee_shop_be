import { Module } from '@nestjs/common';
import { PaginationUtilModule } from '../../common/utils/pagination-util/pagination-util.module';
import { PrintAgentController } from './print-agent.controller';
import { PrintDeviceGuard } from './print-device.guard';
import { PrintEventConsumerService } from './print-event-consumer.service';
import { PrintingController } from './printing.controller';
import { PrintingService } from './printing.service';

@Module({
  imports: [PaginationUtilModule],
  controllers: [PrintingController, PrintAgentController],
  providers: [PrintingService, PrintDeviceGuard, PrintEventConsumerService],
  exports: [PrintingService],
})
export class PrintingModule {}
