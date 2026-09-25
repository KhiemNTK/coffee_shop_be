import { Module } from '@nestjs/common';
import { DateUtilModule } from '../../common/utils/date-util/date-util.module';
import { ExcelUtilModule } from '../../common/utils/excel-util/excel-util.module';
import { ReportsController } from './reports.controller';
import { ReportsService } from './reports.service';
import { DailySalesCloseService } from './daily-sales-close.service';

@Module({
  imports: [DateUtilModule, ExcelUtilModule],
  controllers: [ReportsController],
  providers: [ReportsService, DailySalesCloseService],
})
export class ReportsModule {}
