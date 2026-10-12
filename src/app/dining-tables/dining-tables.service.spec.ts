import { TableStatus } from '@prisma/client';
import { ConflictException } from '@nestjs/common';
import type { ExtendedPrismaClient } from '../../common/prisma/prisma.service';
import { DiningTablesService } from './dining-tables.service';

describe('DiningTablesService', () => {
  const diningTable = {
    findFirst: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
    updateMany: jest.fn(),
    findMany: jest.fn(),
  };
  const service = new DiningTablesService({
    diningTable,
  } as unknown as ExtendedPrismaClient);

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('always creates a table as empty', async () => {
    diningTable.findFirst.mockResolvedValue(null);
    diningTable.create.mockResolvedValue({ id: 'table-id' });

    await service.createTable({ name: 'A1' });

    expect(diningTable.create).toHaveBeenCalledWith({
      data: { name: 'A1', status: TableStatus.EMPTY },
    });
  });

  it('updates table metadata without exposing operational status', async () => {
    diningTable.findFirst
      .mockResolvedValueOnce({
        id: 'table-id',
        name: 'A1',
        status: TableStatus.EMPTY,
      })
      .mockResolvedValueOnce(null);
    diningTable.update.mockResolvedValue({ id: 'table-id', name: 'A2' });

    await service.updateTable('table-id', { name: 'A2' });

    expect(diningTable.update).toHaveBeenCalledWith({
      where: { id: 'table-id' },
      data: { name: 'A2' },
    });
  });

  it('soft-deletes an empty table', async () => {
    diningTable.findFirst.mockResolvedValue({
      id: 'table-id',
      name: 'A1',
      status: TableStatus.EMPTY,
    });
    diningTable.updateMany.mockResolvedValue({ count: 1 });

    await service.deleteTable('table-id');

    expect(diningTable.updateMany).toHaveBeenCalledWith({
      where: {
        id: 'table-id',
        deletedAt: null,
        status: TableStatus.EMPTY,
        orderSessions: { none: { sessionStatus: 'ACTIVE' } },
      },
      data: { deletedAt: expect.any(Date) },
    });
  });

  it('rejects a table claimed after the metadata read', async () => {
    diningTable.findFirst.mockResolvedValue({
      id: 'table-id',
      name: 'A1',
      status: TableStatus.EMPTY,
    });
    diningTable.updateMany.mockResolvedValue({ count: 0 });
    await expect(service.deleteTable('table-id')).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(diningTable.update).not.toHaveBeenCalled();
  });
});
