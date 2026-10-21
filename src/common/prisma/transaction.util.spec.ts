import { ConflictException, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { ExtendedPrismaClient } from './prisma.service';
import { transactionRetriesTotal } from '../observability/metrics';
import { runSerializableTransaction } from './transaction.util';

describe('Serializable transaction retries', () => {
  afterEach(() => jest.restoreAllMocks());

  it.each([
    ['P2034', undefined],
    ['P2010', '40001'],
    ['P2010', '40P01'],
  ])(
    'retries %s (%s) and keeps serializable isolation',
    async (code, sqlState) => {
      const conflict = new Prisma.PrismaClientKnownRequestError('conflict', {
        code,
        clientVersion: 'test',
        meta: sqlState ? { code: sqlState } : undefined,
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
        error_code: code,
      });
    },
  );

  it('reruns the whole transaction and preserves a resulting business conflict', async () => {
    const transient = new Prisma.PrismaClientKnownRequestError(
      'serialization failure',
      {
        code: 'P2010',
        clientVersion: 'test',
        meta: { code: '40001' },
      },
    );
    const insufficientStock = new ConflictException({
      code: 'INVENTORY_INSUFFICIENT_STOCK',
    });
    const firstTx = { attempt: 1 };
    const secondTx = { attempt: 2 };
    const operation = jest
      .fn()
      .mockRejectedValueOnce(transient)
      .mockRejectedValueOnce(insufficientStock);
    const prisma = {
      $transaction: jest
        .fn()
        .mockImplementationOnce((callback) => callback(firstTx))
        .mockImplementationOnce((callback) => callback(secondTx)),
    };
    jest.spyOn(Logger, 'warn').mockImplementation();
    await expect(
      runSerializableTransaction(
        prisma as unknown as ExtendedPrismaClient,
        operation,
        { delayMs: 0 },
      ),
    ).rejects.toBe(insufficientStock);
    expect(operation.mock.calls).toEqual([[firstTx], [secondTx]]);
    expect(prisma.$transaction).toHaveBeenCalledTimes(2);
  });

  it.each(['40001', '40P01'])(
    'limits retries for persistent raw SQL conflict %s',
    async (code) => {
      const error = new Prisma.PrismaClientKnownRequestError('conflict', {
        code: 'P2010',
        clientVersion: 'test',
        meta: { code },
      });
      const prisma = { $transaction: jest.fn().mockRejectedValue(error) };
      const increment = jest.spyOn(transactionRetriesTotal, 'inc');
      jest.spyOn(Logger, 'warn').mockImplementation();
      await expect(
        runSerializableTransaction(
          prisma as unknown as ExtendedPrismaClient,
          jest.fn(),
          { delayMs: 0 },
        ),
      ).rejects.toBe(error);
      expect(prisma.$transaction).toHaveBeenCalledTimes(3);
      expect(increment).toHaveBeenCalledTimes(2);
    },
  );

  it.each([undefined, '23505', '23514', '42501', '42601', '42883'])(
    'does not retry permanent or unknown raw SQL error %s',
    async (code) => {
      const error = new Prisma.PrismaClientKnownRequestError(
        'raw query failed',
        {
          code: 'P2010',
          clientVersion: 'test',
          meta: code ? { code } : undefined,
        },
      );
      const prisma = { $transaction: jest.fn().mockRejectedValue(error) };
      await expect(
        runSerializableTransaction(
          prisma as unknown as ExtendedPrismaClient,
          jest.fn(),
        ),
      ).rejects.toBe(error);
      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    },
  );

  it.each([false, true])(
    'keeps unique violation retries opt-in (%s)',
    async (retryUniqueViolations) => {
      const error = new Prisma.PrismaClientKnownRequestError(
        'unique violation',
        {
          code: 'P2002',
          clientVersion: 'test',
        },
      );
      const prisma = {
        $transaction: jest
          .fn()
          .mockRejectedValueOnce(error)
          .mockResolvedValue('committed'),
      };
      jest.spyOn(Logger, 'warn').mockImplementation();
      const result = runSerializableTransaction(
        prisma as unknown as ExtendedPrismaClient,
        jest.fn(),
        { retryUniqueViolations, delayMs: 0 },
      );
      if (retryUniqueViolations) {
        await expect(result).resolves.toBe('committed');
        expect(prisma.$transaction).toHaveBeenCalledTimes(2);
      } else {
        await expect(result).rejects.toBe(error);
        expect(prisma.$transaction).toHaveBeenCalledTimes(1);
      }
    },
  );

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
