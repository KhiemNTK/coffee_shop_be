import { Test } from '@nestjs/testing';
import { ConflictException } from '@nestjs/common';
import { InventoryItemService } from './inventory-item.service';
import { UnitService } from './unit.service';
import { InventoryRepository } from '../repositories/inventory.repository';
import { InventoryTransactionService } from './inventory-transaction.service';
import { InventoryAuditService } from './inventory-audit.service';
import { InventoryPolicyService } from '../policies/inventory-policy.service';
import { OutboxService } from '../../durable/outbox.service';
import { PaginationUtilService } from '../../../common/utils/pagination-util/pagination-util.service';
import { QueryUtilService } from '../../../common/utils/query-util/query-util.service';

describe('Inventory measurement safety', () => {
  const tx = {
    employee: { findFirst: jest.fn() },
    inventoryItem: { update: jest.fn() },
    unit: { findFirst: jest.fn(), update: jest.fn() },
    $queryRaw: jest.fn(),
  };
  let items: InventoryItemService;
  let units: UnitService;

  beforeEach(async () => {
    jest.resetAllMocks();
    tx.employee.findFirst.mockResolvedValue({ isActive: true });
    tx.unit.findFirst.mockResolvedValue({ name: 'g' });
    tx.$queryRaw.mockResolvedValue([{ used: true }]);
    tx.inventoryItem.update.mockResolvedValue({ id: 'item-id' });
    const module = await Test.createTestingModule({
      providers: [
        InventoryItemService,
        UnitService,
        InventoryPolicyService,
        {
          provide: InventoryRepository,
          useValue: {
            ensureActiveItemExists: jest.fn().mockResolvedValue({
              unitId: 'grams',
              categoryId: 'category-id',
            }),
            ensureActiveUnitExists: jest
              .fn()
              .mockResolvedValue({ id: 'grams' }),
            ensureUnitNameAvailable: jest.fn(),
          },
        },
        {
          provide: InventoryTransactionService,
          useValue: {
            runSerializable: (callback: (client: typeof tx) => unknown) =>
              callback(tx),
          },
        },
        { provide: InventoryAuditService, useValue: { log: jest.fn() } },
        { provide: OutboxService, useValue: { enqueue: jest.fn() } },
        { provide: PaginationUtilService, useValue: {} },
        { provide: QueryUtilService, useValue: {} },
      ],
    }).compile();
    items = module.get(InventoryItemService);
    units = module.get(UnitService);
  });

  it('rejects changing an item measurement unit without touching stock', async () => {
    await expect(
      items.update('item-id', 'employee-id', { unitId: 'kilograms' }),
    ).rejects.toThrow(ConflictException);
    expect(tx.inventoryItem.update).not.toHaveBeenCalled();
  });

  it('accepts an unchanged unit from legacy clients', async () => {
    await expect(
      items.update('item-id', 'employee-id', { unitId: 'grams' }),
    ).resolves.toEqual({ id: 'item-id' });
  });

  it('rejects renaming a unit with current or historical inventory usage', async () => {
    await expect(
      units.update('grams', 'employee-id', { name: 'kg' }),
    ).rejects.toThrow(ConflictException);
    expect(tx.unit.update).not.toHaveBeenCalled();
  });

  it('allows renaming an unused unit and replaying the existing name', async () => {
    tx.$queryRaw.mockResolvedValue([{ used: false }]);
    await units.update('grams', 'employee-id', { name: 'gram' });
    expect(tx.unit.update).toHaveBeenCalledTimes(1);
    tx.$queryRaw.mockClear();
    await units.update('grams', 'employee-id', { name: 'g' });
    expect(tx.$queryRaw).not.toHaveBeenCalled();
  });
});
