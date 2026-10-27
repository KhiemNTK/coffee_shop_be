import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrintingService } from './printing.service';

@Injectable()
export class PrintLeaseRecoveryService
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private readonly logger = new Logger(PrintLeaseRecoveryService.name);
  private timer?: NodeJS.Timeout;
  private running?: Promise<void>;

  constructor(
    private readonly config: ConfigService,
    private readonly printing: PrintingService,
  ) {}

  onApplicationBootstrap() {
    if (this.config.get<string>('NODE_ENV') === 'test') return;
    this.timer = setInterval(() => void this.run(), 15_000);
    this.timer.unref();
    void this.run();
  }

  async onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
    await this.running;
  }

  run(): Promise<void> {
    this.running ??= this.printing
      .recoverExpiredLeases()
      .then((recovered) => {
        if (recovered > 0)
          this.logger.warn({
            event: 'printing.review_required',
            recoveredJobs: recovered,
          });
      })
      .catch((error: unknown) => {
        this.logger.error(
          'Print lease recovery failed.',
          error instanceof Error ? error.stack : undefined,
        );
      })
      .finally(() => {
        this.running = undefined;
      });
    return this.running;
  }
}
