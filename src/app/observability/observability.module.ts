import { Module } from '@nestjs/common';
import { HealthModule } from '../health/health.module';
import { MetricsController } from './metrics.controller';
import { MetricsService } from './metrics.service';

@Module({
  imports: [HealthModule],
  controllers: [MetricsController],
  providers: [MetricsService],
})
export class ObservabilityModule {}
