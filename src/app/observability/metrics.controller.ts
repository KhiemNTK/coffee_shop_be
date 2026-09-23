import {
  Controller,
  Get,
  Headers,
  NotFoundException,
  Res,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { timingSafeEqual } from 'node:crypto';
import type { Response } from 'express';
import { SkipAuth } from '../auth/auth.decorator';
import { MetricsService } from './metrics.service';

@Controller()
@SkipAuth()
export class MetricsController {
  constructor(
    private readonly metricsService: MetricsService,
    private readonly config: ConfigService,
  ) {}

  @Get('metrics')
  async scrape(
    @Headers('authorization') authorization: string | undefined,
    @Res() response: Response,
  ) {
    if (!this.metricsService.isEnabled()) throw new NotFoundException();
    if (!this.isAuthorized(authorization)) throw new UnauthorizedException();

    response.setHeader('Content-Type', this.metricsService.contentType);
    response.send(await this.metricsService.render());
  }

  private isAuthorized(authorization?: string) {
    const expected = this.config.get<string>('METRICS_TOKEN');
    if (!expected) {
      return (
        this.config.get<string>('NODE_ENV', 'development') !== 'production'
      );
    }

    const provided = authorization?.startsWith('Bearer ')
      ? authorization.slice('Bearer '.length)
      : '';
    const expectedBuffer = Buffer.from(expected);
    const providedBuffer = Buffer.from(provided);
    return (
      expectedBuffer.length === providedBuffer.length &&
      timingSafeEqual(expectedBuffer, providedBuffer)
    );
  }
}
