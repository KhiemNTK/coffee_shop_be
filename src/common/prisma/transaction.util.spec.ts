import { Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { ExtendedPrismaClient } from './prisma.service';
import { transactionRetriesTotal } from '../observability/metrics';
import { runSerializableTransaction } from './transaction.util';

describe('Serializable transaction retry metrics', () => {
  afterEach(() => jest.restoreAllMocks());

  it('counts a conflict retry and keeps serializable isolation', async () => {
    const conflict = new Prisma.PrismaClientKnownRequestError('conflict', {
      code: 'P2034',
      clientVersion: 'test',
    });
    const tx = {};
    const prisma = {
      $transaction: jest
        .fn()
        .mockRejectedValueOnce(conflict)
        .mockImplementation((callback) => callback(tx)),
    };
    const increment = jest.spyOn(transactionRetriesTotal, 'inc');
    jest.spyOn(Logger, 'warn').mockImplementation();
    const operation = jest.fn().mockResolvedValue('committed');
    await expect(
      runSerializableTransaction(
        prisma as unknown as ExtendedPrismaClient,
        operation,
        { delayMs: 0 },
      ),
    ).resolves.toBe('committed');
    expect(operation).toHaveBeenCalledTimes(1);
    expect(prisma.$transaction).toHaveBeenCalledTimes(2);
    expect(prisma.$transaction).toHaveBeenCalledWith(operation, {
      isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
    });
    expect(increment).toHaveBeenCalledWith({
      context: 'Transaction',
      error_code: 'P2034',
    });
  });

  it('does not retry business conflicts or permanent database errors', async () => {
    const error = new Error('Permanent failure');
    const prisma = { $transaction: jest.fn().mockRejectedValue(error) };
    const increment = jest.spyOn(transactionRetriesTotal, 'inc');
    await expect(
      runSerializableTransaction(
        prisma as unknown as ExtendedPrismaClient,
        jest.fn(),
      ),
    ).rejects.toBe(error);
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(increment).not.toHaveBeenCalled();
  });
});
