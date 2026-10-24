import { Module } from '@nestjs/common';
import { InvoicesService } from './invoices.service';
import { CashRefundsService } from './cash-refunds.service';
import { InvoicesController } from './invoices.controller';
import { PaginationUtilModule } from '../../common/utils/pagination-util/pagination-util.module';
import { PromotionsModule } from '../promotions/promotions.module';
import { InvoiceNumberService } from './invoice-number.service';
import { InvoicePolicyService } from './invoice-policy.service';
import { CashierShiftsModule } from '../cashier-shifts/cashier-shifts.module';
import { InventoryModule } from '../inventory/inventory.module';

@Module({
  imports: [
    CashierShiftsModule,
    PaginationUtilModule,
    PromotionsModule,
    InventoryModule,
  ],
  controllers: [InvoicesController],
  providers: [
    InvoicesService,
    CashRefundsService,
    InvoicePolicyService,
    InvoiceNumberService,
  ],
  exports: [InvoicesService],
})
export class InvoicesModule {}
