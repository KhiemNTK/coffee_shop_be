import { Module } from '@nestjs/common';
import { DateUtilModule } from '../../common/utils/date-util/date-util.module';
import { ExcelUtilModule } from '../../common/utils/excel-util/excel-util.module';
import { ReportsController } from './reports.controller';
import { ReportsService } from './reports.service';
import { DailySalesCloseService } from './daily-sales-close.service';
import { BusinessInsightsController } from './business-insights.controller';
import { BusinessInsightsService } from './business-insights.service';
import { BusinessInsightSnapshotService } from './business-insight-snapshot.service';
import { GeminiInsightsService } from './gemini-insights.service';

@Module({
  imports: [DateUtilModule, ExcelUtilModule],
  controllers: [ReportsController, BusinessInsightsController],
  providers: [
    ReportsService,
    DailySalesCloseService,
    BusinessInsightsService,
    BusinessInsightSnapshotService,
    GeminiInsightsService,
  ],
})
export class ReportsModule {}
