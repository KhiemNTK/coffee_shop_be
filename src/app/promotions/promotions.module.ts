import { Module } from '@nestjs/common';
import { PromotionsService } from './promotions.service';
import { PromotionsController } from './promotions.controller';
import { PaginationUtilModule } from '../../common/utils/pagination-util/pagination-util.module';
import { PromotionEventsPublisher } from './events/promotion-events.publisher';
import { PromotionPolicyService } from './policies/promotion-policy.service';
import { PromotionsRepository } from './repositories/promotions.repository';
import { PromotionAuditService } from './services/promotion-audit.service';
import { PromotionCalculatorService } from './services/promotion-calculator.service';
import { PromotionQueryService } from './services/promotion-query.service';
import { PromotionTransactionService } from './services/promotion-transaction.service';

@Module({
  imports: [PaginationUtilModule],
  controllers: [PromotionsController],
  providers: [
    PromotionsService,
    PromotionsRepository,
    PromotionPolicyService,
    PromotionAuditService,
    PromotionTransactionService,
    PromotionQueryService,
    PromotionCalculatorService,
    PromotionEventsPublisher,
  ],
  exports: [
    PromotionsService,
    PromotionCalculatorService,
    PromotionEventsPublisher,
  ],
})
export class PromotionsModule {}
