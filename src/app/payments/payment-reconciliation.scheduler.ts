import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PaymentReconciliationService } from './payment-reconciliation.service';
import { PaymentRefundsService } from './payment-refunds.service';

const RECONCILIATION_INTERVAL_MS = 5 * 60 * 1_000;

@Injectable()
export class PaymentReconciliationScheduler
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private readonly logger = new Logger(PaymentReconciliationScheduler.name);
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(
    private readonly config: ConfigService,
    private readonly reconciliation: PaymentReconciliationService,
    private readonly refunds: PaymentRefundsService,
  ) {}

  onApplicationBootstrap() {
    if (this.config.get<string>('NODE_ENV') === 'test') return;
    this.timer = setInterval(() => void this.run(), RECONCILIATION_INTERVAL_MS);
    this.timer.unref();
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  private async run() {
    if (this.running) return;
    this.running = true;
    try {
      await this.refunds.recoverPendingRefunds();
      await this.reconciliation.reconcileDue();
    } catch (error) {
      this.logger.error(
        'Payment reconciliation cycle failed.',
        error instanceof Error ? error.stack : undefined,
      );
    } finally {
      this.running = false;
    }
  }
}
