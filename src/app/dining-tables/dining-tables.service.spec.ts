import { TableStatus } from '@prisma/client';
import type { ExtendedPrismaClient } from '../../common/prisma/prisma.service';
import { DiningTablesService } from './dining-tables.service';

describe('DiningTablesService', () => {
  const diningTable = {
    findFirst: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
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
    diningTable.update.mockResolvedValue({ id: 'table-id' });

    await service.deleteTable('table-id');

    expect(diningTable.update).toHaveBeenCalledWith({
      where: { id: 'table-id' },
      data: { deletedAt: expect.any(Date) },
    });
  });
});
