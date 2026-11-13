import {
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { VouchersService } from './vouchers.service';

@Injectable()
export class VoucherExpiryService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(VoucherExpiryService.name);
  private timer?: NodeJS.Timeout;
  private running?: Promise<void>;

  constructor(private readonly vouchers: VouchersService) {}

  onModuleInit() {
    if (process.env.NODE_ENV === 'test') return;
    this.timer = setInterval(() => this.cleanup(), 60_000);
    this.timer.unref();
  }

  async onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
    await this.running;
  }

  private cleanup() {
    if (this.running) return;
    this.running = this.vouchers
      .releaseExpiredReservations()
      .then(() => {})
      .catch(() => {
        this.logger.error('Voucher reservation expiry cleanup failed.');
      })
      .finally(() => {
        this.running = undefined;
      });
  }
}
