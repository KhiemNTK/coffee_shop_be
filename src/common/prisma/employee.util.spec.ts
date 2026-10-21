import { UnauthorizedException } from '@nestjs/common';
import type { ExtendedPrismaTransactionClient } from '../types/prisma.types';
import { assertActiveEmployee } from './employee.util';

describe('assertActiveEmployee', () => {
  const findFirst = jest.fn();
  const client = { employee: { findFirst } } as unknown as Pick<
    ExtendedPrismaTransactionClient,
    'employee'
  >;

  beforeEach(() => findFirst.mockReset());

  it('uses the supplied transaction/client and selects only the active employee ID', async () => {
    findFirst.mockResolvedValue({ id: 'employee-id' });
    await expect(
      assertActiveEmployee(client, 'employee-id'),
    ).resolves.toBeUndefined();
    expect(findFirst).toHaveBeenCalledTimes(1);
    expect(findFirst).toHaveBeenCalledWith({
      where: { id: 'employee-id', isActive: true, deletedAt: null },
      select: { id: true },
    });
  });

  it('preserves the unauthorized response for missing, inactive or deleted employees', async () => {
    findFirst.mockResolvedValue(null);
    await expect(assertActiveEmployee(client, 'employee-id')).rejects.toEqual(
      new UnauthorizedException('Employee is inactive or not found.'),
    );
  });

  it('propagates database errors instead of hiding them as authentication failures', async () => {
    const error = new Error('connection unavailable');
    findFirst.mockRejectedValue(error);
    await expect(assertActiveEmployee(client, 'employee-id')).rejects.toBe(
      error,
    );
  });
});
