import { Test, TestingModule } from '@nestjs/testing';
import { PromotionEventsPublisher } from './events/promotion-events.publisher';
import { PromotionPolicyService } from './policies/promotion-policy.service';
import { PromotionsService } from './promotions.service';
import { PromotionsRepository } from './repositories/promotions.repository';
import { PromotionAuditService } from './services/promotion-audit.service';
import { PromotionQueryService } from './services/promotion-query.service';
import { PromotionTransactionService } from './services/promotion-transaction.service';

describe('PromotionsService', () => {
  let service: PromotionsService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PromotionsService,
        { provide: PromotionsRepository, useValue: {} },
        { provide: PromotionPolicyService, useValue: {} },
        { provide: PromotionTransactionService, useValue: {} },
        { provide: PromotionAuditService, useValue: {} },
        { provide: PromotionQueryService, useValue: {} },
        { provide: PromotionEventsPublisher, useValue: {} },
      ],
    }).compile();

    service = module.get<PromotionsService>(PromotionsService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });
});
