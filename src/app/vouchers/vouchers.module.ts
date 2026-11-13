import { Module } from '@nestjs/common';
import { PaginationUtilModule } from '../../common/utils/pagination-util/pagination-util.module';
import { PromotionsModule } from '../promotions/promotions.module';
import { VoucherCampaignsController } from './voucher-campaigns.controller';
import { VoucherCampaignsService } from './voucher-campaigns.service';
import { VoucherExpiryService } from './voucher-expiry.service';
import { VoucherGrantsController } from './voucher-grants.controller';
import { VouchersService } from './vouchers.service';

@Module({
  imports: [PromotionsModule, PaginationUtilModule],
  controllers: [VoucherCampaignsController, VoucherGrantsController],
  providers: [VouchersService, VoucherCampaignsService, VoucherExpiryService],
  exports: [VouchersService, VoucherCampaignsService],
})
export class VouchersModule {}
