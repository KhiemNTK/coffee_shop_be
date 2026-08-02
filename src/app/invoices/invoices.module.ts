import { Module } from '@nestjs/common';
import { InvoicesService } from './invoices.service';
import { InvoicesController } from './invoices.controller';
import { PaginationUtilModule } from '../../common/utils/pagination-util/pagination-util.module';
import { OrdersModule } from '../orders/orders.module';
import { PromotionsModule } from '../promotions/promotions.module';
import { InvoiceNumberService } from './invoice-number.service';
import { InvoicePolicyService } from './invoice-policy.service';

@Module({
  imports: [OrdersModule, PaginationUtilModule, PromotionsModule],
  controllers: [InvoicesController],
  providers: [InvoicesService, InvoicePolicyService, InvoiceNumberService],
})
export class InvoicesModule {}
