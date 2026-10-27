import { ConflictException, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PositionsService } from './positions.service';
import { CreatePositionInputSchema } from './dto/create-position.dto';
import { UpdatePositionDto } from './dto/update-position.dto';

describe('PositionsService', () => {
  const position = {
    id: 'position',
    name: 'Barista',
    salary: new Prisma.Decimal('8500000.01'),
  };
  const tx = {
    employee: { findFirst: jest.fn(), count: jest.fn() },
    position: { findFirst: jest.fn(), create: jest.fn(), update: jest.fn() },
    actionLog: { create: jest.fn() },
  };
  const prisma = { $transaction: jest.fn((fn) => fn(tx)) };
  const service = new PositionsService(
    prisma as never,
    {} as never,
    {} as never,
  );

  beforeEach(() => {
    jest.clearAllMocks();
    tx.employee.findFirst.mockResolvedValue({ id: 'actor' });
    tx.employee.count.mockResolvedValue(0);
    tx.position.findFirst.mockResolvedValue(position);
    tx.position.create.mockResolvedValue(position);
    tx.position.update.mockResolvedValue(position);
  });

  it.each([null, '', '8500000.009', '10000000000000000', -1])(
    'rejects invalid salary %p on create and update',
    (salary) => {
      expect(
        CreatePositionInputSchema.safeParse({ name: 'Barista', salary })
          .success,
      ).toBe(false);
      expect(UpdatePositionDto.schema.safeParse({ salary }).success).toBe(
        false,
      );
    },
  );

  it('preserves exact large decimal input', () => {
    expect(
      CreatePositionInputSchema.parse({
        name: 'Barista',
        salary: '9999999999999999.99',
      }).salary,
    ).toBe('9999999999999999.99');
  });

  it('blocks deletion while any non-deleted employee is assigned, including inactive staff', async () => {
    tx.employee.count.mockResolvedValue(1);
    await expect(
      service.deletePosition('position', 'actor'),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(tx.employee.count).toHaveBeenCalledWith({
      where: { positionId: 'position', deletedAt: null },
    });
    expect(tx.position.update).not.toHaveBeenCalled();
    expect(tx.actionLog.create).not.toHaveBeenCalled();
  });

  it('does not update a missing or deleted position', async () => {
    tx.position.findFirst.mockResolvedValue(null);
    await expect(
      service.updatePosition('position', { name: 'New name' }, 'actor'),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(tx.position.update).not.toHaveBeenCalled();
  });

  it('audits salary edits without changing employee salaries', async () => {
    await service.updatePosition('position', { salary: '8500000.01' }, 'actor');
    expect(tx.actionLog.create).toHaveBeenCalledWith({
      data: {
        employeeId: 'actor',
        actionType: 'POSITION_UPDATED',
        details: {
          positionId: 'position',
          before: { name: 'Barista', salary: '8500000.01' },
          after: { name: 'Barista', salary: '8500000.01' },
        },
      },
    });
    expect(prisma.$transaction).toHaveBeenCalledWith(expect.any(Function), {
      isolationLevel: 'Serializable',
    });
  });

  it('audits creation and safe soft deletion', async () => {
    await service.createPosition(
      { name: 'Barista', salary: '8500000.01' },
      'actor',
    );
    await service.deletePosition('position', 'actor');
    expect(tx.actionLog.create).toHaveBeenCalledTimes(2);
    expect(tx.position.update).toHaveBeenCalledWith({
      where: { id: 'position', deletedAt: null },
      data: { deletedAt: expect.any(Date) },
    });
  });
});
