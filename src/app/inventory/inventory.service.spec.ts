import { Test, TestingModule } from '@nestjs/testing';
import { InventoryService } from './inventory.service';
import { InventoryCategoryService } from './services/inventory-category.service';
import { InventoryItemService } from './services/inventory-item.service';
import { InventoryMovementService } from './services/inventory-movement.service';
import { InventoryQueryService } from './services/inventory-query.service';
import { UnitService } from './services/unit.service';

describe('InventoryService', () => {
  let service: InventoryService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        InventoryService,
        { provide: InventoryCategoryService, useValue: {} },
        { provide: UnitService, useValue: {} },
        { provide: InventoryItemService, useValue: {} },
        { provide: InventoryMovementService, useValue: {} },
        { provide: InventoryQueryService, useValue: {} },
      ],
    }).compile();

    service = module.get<InventoryService>(InventoryService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });
});
