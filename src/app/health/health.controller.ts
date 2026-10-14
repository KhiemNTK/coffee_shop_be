import { Controller, Get } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import { SkipAuth } from '../auth/auth.decorator';
import { HealthService } from './health.service';

@Controller('health')
@SkipAuth()
@SkipThrottle()
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
