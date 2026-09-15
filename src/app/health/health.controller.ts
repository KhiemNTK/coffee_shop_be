import { Controller, Get } from '@nestjs/common';
import { SkipAuth } from '../auth/auth.decorator';
import { HealthService } from './health.service';

@Controller('health')
@SkipAuth()
export class HealthController {
  constructor(private readonly healthService: HealthService) {}

  @Get('live')
  liveness() {
    return this.healthService.liveness();
  }

  @Get('ready')
  readiness() {
    return this.healthService.readiness();
  }
}
