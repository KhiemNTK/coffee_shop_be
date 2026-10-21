import { Module } from '@nestjs/common';
import { HealthModule } from '../health/health.module';
import { MetricsController } from './metrics.controller';
import { MetricsService } from './metrics.service';
import { ReportsModule } from '../reports/reports.module';

@Module({
  imports: [HealthModule, ReportsModule],
  controllers: [MetricsController],
  providers: [MetricsService],
})
export class ObservabilityModule {}
