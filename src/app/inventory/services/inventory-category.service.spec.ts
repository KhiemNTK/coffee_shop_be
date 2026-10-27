import { NotFoundException } from '@nestjs/common';
import { InventoryPolicyService } from '../policies/inventory-policy.service';
import { InventoryCategoryService } from './inventory-category.service';

describe('Inventory category update boundary', () => {
  const tx = {
    employee: { findFirst: jest.fn() },
    inventoryCategory: { update: jest.fn() },
  };
  const repository = {
    ensureActiveCategoryExists: jest.fn(),
    ensureCategoryNameAvailable: jest.fn(),
  };
  const audit = { log: jest.fn() };
  const transaction = { runSerializable: jest.fn((callback) => callback(tx)) };
  const service = new InventoryCategoryService(
    repository as never,
    {} as never,
    {} as never,
    new InventoryPolicyService(),
    transaction as never,
    audit,
  );

  beforeEach(() => {
    jest.clearAllMocks();
    tx.employee.findFirst.mockResolvedValue({ isActive: true });
    repository.ensureActiveCategoryExists.mockResolvedValue({
      id: 'category-id',
    });
    tx.inventoryCategory.update.mockResolvedValue({
      id: 'category-id',
      name: 'Tea',
    });
  });

  it('checks both state and uniqueness on the same transaction client before updating', async () => {
    await service.update('category-id', 'actor', { name: 'Tea' });
    expect(repository.ensureActiveCategoryExists).toHaveBeenCalledWith(
      'category-id',
      tx,
    );
    expect(repository.ensureCategoryNameAvailable).toHaveBeenCalledWith(
      'Tea',
      'category-id',
      tx,
    );
    expect(tx.inventoryCategory.update).toHaveBeenCalledWith({
      where: { id: 'category-id', deletedAt: null },
      data: { name: 'Tea' },
    });
    expect(audit.log).toHaveBeenCalledTimes(1);
  });

  it('does not update or audit a category archived before the transaction starts', async () => {
    repository.ensureActiveCategoryExists.mockRejectedValue(
      new NotFoundException(),
    );
    await expect(
      service.update('category-id', 'actor', { description: 'Changed' }),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(tx.inventoryCategory.update).not.toHaveBeenCalled();
    expect(audit.log).not.toHaveBeenCalled();
  });
});
