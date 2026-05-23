import { Module } from '@nestjs/common';
import { ImportOrdersService } from './import-orders.service';
import { ImportOrdersController } from './import-orders.controller';

@Module({
  controllers: [ImportOrdersController],
  providers: [ImportOrdersService],
})
export class ImportOrdersModule {}
