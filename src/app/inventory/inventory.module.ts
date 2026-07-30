import { Module } from '@nestjs/common';
import { InventoryService } from './inventory.service';
import { InventoryController } from './inventory.controller';
import { PaginationUtilModule } from '../../common/utils/pagination-util/pagination-util.module';
import { QueryUtilModule } from '../../common/utils/query-util/query-util.module';
import { InventoryEventsPublisher } from './events/inventory-events.publisher';
import { InventoryPolicyService } from './policies/inventory-policy.service';
import { InventoryRepository } from './repositories/inventory.repository';
import { InventoryAuditService } from './services/inventory-audit.service';
import { InventoryCategoryService } from './services/inventory-category.service';
import { InventoryItemService } from './services/inventory-item.service';
import { InventoryMovementService } from './services/inventory-movement.service';
import { InventoryQueryService } from './services/inventory-query.service';
import { InventoryTransactionService } from './services/inventory-transaction.service';
import { UnitService } from './services/unit.service';

@Module({
  imports: [PaginationUtilModule, QueryUtilModule],
  controllers: [InventoryController],
  providers: [
    InventoryService,
    InventoryRepository,
    InventoryPolicyService,
    InventoryAuditService,
    InventoryTransactionService,
    InventoryCategoryService,
    UnitService,
    InventoryItemService,
    InventoryMovementService,
    InventoryQueryService,
    InventoryEventsPublisher,
  ],
  exports: [
    InventoryService,
    InventoryMovementService,
    InventoryQueryService,
    InventoryEventsPublisher,
  ],
})
export class InventoryModule {}
