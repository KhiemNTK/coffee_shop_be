import { Module } from '@nestjs/common';
import { ExcelUtilModule } from '../../common/utils/excel-util/excel-util.module';
import { ReportsController } from './reports.controller';
import { ReportsService } from './reports.service';
import { DailySalesCloseService } from './daily-sales-close.service';
import { BusinessInsightsController } from './business-insights.controller';
import { BusinessInsightsService } from './business-insights.service';
import { BusinessInsightSnapshotService } from './business-insight-snapshot.service';
import { GeminiInsightsService } from './gemini-insights.service';
import { BusinessInsightHistoryService } from './business-insight-history.service';

@Module({
  imports: [ExcelUtilModule],
  controllers: [ReportsController, BusinessInsightsController],
  providers: [
    ReportsService,
    DailySalesCloseService,
    BusinessInsightsService,
    BusinessInsightSnapshotService,
    GeminiInsightsService,
    BusinessInsightHistoryService,
  ],
  exports: [BusinessInsightsService],
})
export class ReportsModule {}
