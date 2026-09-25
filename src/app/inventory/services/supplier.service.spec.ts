import { ConflictException } from '@nestjs/common';
import { InventoryPolicyService } from '../policies/inventory-policy.service';
import { SupplierService } from './supplier.service';

describe('SupplierService', () => {
  let service: SupplierService;
  let tx: any;

  beforeEach(() => {
    tx = {
      employee: { findFirst: jest.fn().mockResolvedValue({ isActive: true }) },
      supplier: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockImplementation(({ data }) => ({
          id: 'supplier-id',
          ...data,
        })),
        update: jest.fn(),
      },
      purchaseReceipt: { count: jest.fn().mockResolvedValue(0) },
    };
    service = new SupplierService(
      {} as never,
      new InventoryPolicyService(),
      { runSerializable: jest.fn((operation) => operation(tx)) } as never,
      { log: jest.fn() },
      {} as never,
    );
  });

  it('normalizes supplier codes before persisting', async () => {
    const result = await service.create('employee-id', {
      code: ' acme-01 ',
      name: 'Acme Coffee',
    });

    expect(tx.supplier.create).toHaveBeenCalledWith({
      data: { code: 'ACME-01', name: 'Acme Coffee' },
    });
    expect(result).toEqual(
      expect.objectContaining({ id: 'supplier-id', code: 'ACME-01' }),
    );
  });

  it('rejects an active duplicate supplier code', async () => {
    tx.supplier.findFirst.mockResolvedValue({ id: 'existing-id' });

    await expect(
      service.create('employee-id', {
        code: 'ACME-01',
        name: 'Duplicate',
      }),
    ).rejects.toBeInstanceOf(ConflictException);

    expect(tx.supplier.create).not.toHaveBeenCalled();
  });

  it('does not delete a supplier referenced by a draft receipt', async () => {
    tx.supplier.findFirst.mockResolvedValue({ id: 'supplier-id' });
    tx.purchaseReceipt.count.mockResolvedValue(1);

    await expect(
      service.remove('supplier-id', 'employee-id'),
    ).rejects.toBeInstanceOf(ConflictException);

    expect(tx.supplier.update).not.toHaveBeenCalled();
  });
});
