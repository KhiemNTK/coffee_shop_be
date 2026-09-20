import { ConflictException } from '@nestjs/common';
import { IdempotencyRequestStatus } from '@prisma/client';
import type { ExtendedPrismaClient } from '../../common/prisma/prisma.service';
import { IdempotencyService } from './idempotency.service';

describe('IdempotencyService', () => {
  const tx = {
    idempotencyRequest: {
      findUnique: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
    },
  };
  const prisma = {
    idempotencyRequest: { findUnique: jest.fn() },
    $transaction: jest.fn((callback: (client: typeof tx) => unknown) =>
      callback(tx),
    ),
  };
  const service = new IdempotencyService(
    prisma as unknown as ExtendedPrismaClient,
  );

  beforeEach(() => {
    jest.clearAllMocks();
    prisma.idempotencyRequest.findUnique.mockResolvedValue(null);
    tx.idempotencyRequest.findUnique.mockResolvedValue(null);
    tx.idempotencyRequest.create.mockResolvedValue({ id: 'request-id' });
  });

  it('stores the response in the same transaction as the operation', async () => {
    const operation = jest.fn().mockResolvedValue({ id: 'result-id' });

    await expect(
      service.execute(
        {
          employeeId: 'employee-id',
          operation: 'inventory.stock.import',
          key: 'request-key',
          request: { quantity: '1' },
        },
        operation,
      ),
    ).resolves.toEqual({ id: 'result-id' });

    expect(operation).toHaveBeenCalledWith(tx);
    expect(tx.idempotencyRequest.update).toHaveBeenCalledWith({
      where: { id: 'request-id' },
      data: expect.objectContaining({
        status: IdempotencyRequestStatus.COMPLETED,
        response: { id: 'result-id' },
      }),
    });
  });

  it('replays a completed response without running the operation', async () => {
    const operation = jest.fn().mockResolvedValue({ id: 'result-id' });
    const first = service.execute(
      {
        employeeId: 'employee-id',
        operation: 'cashier-shift.close',
        key: 'request-key',
        request: { reportedEndingCash: '0' },
      },
      operation,
    );
    await first;
    const stored = tx.idempotencyRequest.update.mock.calls[0][0].data;
    prisma.idempotencyRequest.findUnique.mockResolvedValue({
      requestHash:
        tx.idempotencyRequest.create.mock.calls[0][0].data.requestHash,
      status: stored.status,
      response: stored.response,
    });

    await expect(
      service.execute(
        {
          employeeId: 'employee-id',
          operation: 'cashier-shift.close',
          key: 'request-key',
          request: { reportedEndingCash: '0' },
        },
        operation,
      ),
    ).resolves.toEqual(stored.response);
    expect(operation).toHaveBeenCalledTimes(1);
  });

  it('rejects a key reused with a different payload', async () => {
    prisma.idempotencyRequest.findUnique.mockResolvedValue({
      requestHash: 'different-hash',
      status: IdempotencyRequestStatus.COMPLETED,
      response: { id: 'result-id' },
    });

    await expect(
      service.execute(
        {
          employeeId: 'employee-id',
          operation: 'invoice.checkout',
          key: 'request-key',
          request: { amount: '2' },
        },
        jest.fn(),
      ),
    ).rejects.toBeInstanceOf(ConflictException);
  });
});
