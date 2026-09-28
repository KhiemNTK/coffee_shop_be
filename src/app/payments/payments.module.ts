import { Module } from '@nestjs/common';
import { PaginationUtilModule } from '../../common/utils/pagination-util/pagination-util.module';
import { CashierShiftsModule } from '../cashier-shifts/cashier-shifts.module';
import { InvoicesModule } from '../invoices/invoices.module';
import { PaymentsController } from './payments.controller';
import { PaymentReconciliationScheduler } from './payment-reconciliation.scheduler';
import { PaymentReconciliationService } from './payment-reconciliation.service';
import { PaymentRefundsService } from './payment-refunds.service';
import { PaymentsService } from './payments.service';
import { MomoService } from './momo.service';
import { PaymentProviderFactory } from './payment-provider.factory';
import { VnpayService } from './vnpay.service';

@Module({
  imports: [CashierShiftsModule, InvoicesModule, PaginationUtilModule],
  controllers: [PaymentsController],
  providers: [
    PaymentsService,
    PaymentRefundsService,
    PaymentReconciliationService,
    PaymentReconciliationScheduler,
    VnpayService,
    MomoService,
    PaymentProviderFactory,
  ],
})
export class PaymentsModule {}
