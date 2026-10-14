import { ConflictException } from '@nestjs/common';
import { IdempotencyRequestStatus, Prisma } from '@prisma/client';
import type { ExtendedPrismaClient } from '../../common/prisma/prisma.service';
import { IdempotencyService } from './idempotency.service';
import { convertDecimalsToNumbers } from '../../common/utils/decimal-response.util';

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

  it('replays the same monetary JSON shape, including nested Decimal values', async () => {
    const operation = jest.fn().mockResolvedValue({
      id: 'invoice',
      totalAmount: new Prisma.Decimal('42000'),
      lines: [{ price: new Prisma.Decimal('21000') }],
      createdAt: new Date('2026-10-13T00:00:00Z'),
      note: '42000',
    });
    const input = {
      employeeId: 'employee',
      operation: 'invoice.checkout',
      key: 'same-request',
      request: {},
    };
    const first = await service.execute(input, operation);
    const stored = tx.idempotencyRequest.update.mock.calls[0][0].data;
    prisma.idempotencyRequest.findUnique.mockResolvedValue({
      ...stored,
      requestHash:
        tx.idempotencyRequest.create.mock.calls[0][0].data.requestHash,
    });
    const replay = await service.execute(input, operation);
    expect(stored.response.totalAmount).toBe(42000);
    expect(JSON.parse(JSON.stringify(convertDecimalsToNumbers(first)))).toEqual(
      replay,
    );
    expect(operation).toHaveBeenCalledTimes(1);
  });
});
