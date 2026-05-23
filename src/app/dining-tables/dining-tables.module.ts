import { Module } from '@nestjs/common';
import { DiningTablesService } from './dining-tables.service';
import { DiningTablesController } from './dining-tables.controller';

@Module({
  controllers: [DiningTablesController],
  providers: [DiningTablesService],
})
export class DiningTablesModule {}
