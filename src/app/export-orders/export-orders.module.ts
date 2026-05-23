import { Module } from '@nestjs/common';
import { ExportOrdersService } from './export-orders.service';
import { ExportOrdersController } from './export-orders.controller';

@Module({
  controllers: [ExportOrdersController],
  providers: [ExportOrdersService],
})
export class ExportOrdersModule {}
