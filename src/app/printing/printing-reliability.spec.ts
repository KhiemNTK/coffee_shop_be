import { ConflictException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrintJobStatus, PrintJobType } from '@prisma/client';
import { PrintingService } from './printing.service';
import { PrintLeaseRecoveryService } from './print-lease-recovery.service';
import { FailPrintJobDto } from './dto';

describe('Print delivery recovery', () => {
  const updatedAt = new Date('2026-10-25T00:00:00.000Z');
  const item = { orderItemId: 'cancelled', name: 'Coffee', quantity: 1 };
  const kept = { orderItemId: 'kept', name: 'Tea', quantity: 2 };
  const tx = {
    employee: { findFirst: jest.fn() },
    printJob: {
      findMany: jest.fn(),
      findUnique: jest.fn(),
      findUniqueOrThrow: jest.fn(),
      updateMany: jest.fn(),
      create: jest.fn(),
      createMany: jest.fn(),
      findFirst: jest.fn(),
    },
    actionLog: { create: jest.fn() },
  };
  const prisma = {
    $transaction: jest.fn((fn) => fn(tx)),
    printJob: tx.printJob,
  };
  const service = new PrintingService(
    prisma as never,
    {} as never,
    {} as never,
    {} as never,
  );

  beforeEach(() => {
    jest.clearAllMocks();
    tx.employee.findFirst.mockResolvedValue({ id: 'actor' });
    tx.printJob.updateMany.mockResolvedValue({ count: 1 });
    tx.printJob.findMany.mockResolvedValue([
      {
        id: 'job',
        type: PrintJobType.KITCHEN_TICKET,
        status: PrintJobStatus.PENDING,
        deviceId: 'printer',
        kitchenTicketId: 'ticket',
        payload: { items: [item, kept] },
        updatedAt,
      },
    ]);
  });

  it('removes only cancelled items from an unclaimed ticket', async () => {
    await service.cancelKitchenItems(
      tx as never,
      ['cancelled'],
      'actor',
      'Wrong drink',
    );
    expect(tx.printJob.updateMany).toHaveBeenCalledWith({
      where: { id: 'job', status: 'PENDING', updatedAt },
      data: { payload: { items: [kept] } },
    });
    expect(tx.printJob.create).not.toHaveBeenCalled();
  });

  it('cancels a fully cancelled pending job instead of printing an empty ticket', async () => {
    await service.cancelKitchenItems(
      tx as never,
      ['cancelled', 'kept'],
      'actor',
      'Customer left',
    );
    expect(tx.printJob.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { status: 'CANCELLED', failedAt: null, payload: { items: [] } },
      }),
    );
  });

  it.each(['PROCESSING', 'PRINTED', 'REQUIRES_REVIEW'])(
    'queues a cancellation notice without rewriting a %s original',
    async (status) => {
      const original = (await tx.printJob.findMany())[0];
      tx.printJob.findMany.mockResolvedValue([{ ...original, status }]);
      await service.cancelKitchenItems(
        tx as never,
        ['cancelled'],
        'actor',
        'Wrong drink',
      );
      expect(tx.printJob.updateMany).not.toHaveBeenCalled();
      expect(tx.printJob.createMany).toHaveBeenCalledWith({
        data: expect.objectContaining({
          kitchenTicketId: 'ticket',
          deviceId: 'printer',
          requestedById: 'actor',
          payload: expect.objectContaining({
            documentType: 'KITCHEN_CANCELLATION',
            originalJobId: 'job',
            reason: 'Wrong drink',
            items: [item],
          }),
        }),
        skipDuplicates: true,
      });
    },
  );

  it('rejects a stale cancellation update so the surrounding business transaction rolls back', async () => {
    tx.printJob.updateMany.mockResolvedValue({ count: 0 });
    await expect(
      service.cancelKitchenItems(tx as never, ['cancelled'], 'actor', 'Cancel'),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('allows completion retries only for the same device and final lease token', async () => {
    tx.printJob.updateMany.mockResolvedValue({ count: 0 });
    tx.printJob.findFirst.mockResolvedValue({ id: 'job' });
    await expect(
      service.completeJob('printer', 'job', 'token'),
    ).resolves.toEqual({ success: true });
    const where = tx.printJob.findFirst.mock.calls[0][0].where;
    expect(where).toEqual({
      id: 'job',
      deviceId: 'printer',
      status: 'PRINTED',
      leaseTokenHash: expect.any(String),
    });
    expect(tx.printJob.updateMany.mock.calls[0][0].data).not.toHaveProperty(
      'leaseTokenHash',
    );
  });

  const split = {
    employeeId: 'actor',
    destinationSessionId: 'destination-session',
    destinationTableName: 'B2',
    moves: [
      {
        orderItemId: 'kept',
        movedOrderItemId: 'moved',
        originalQuantity: 2,
        quantityToMove: 1,
      },
    ],
  };

  it.each(['PENDING', 'FAILED'])(
    'splits an unprinted %s payload without changing other items or its scheduled release',
    async (status) => {
      const original = (await tx.printJob.findMany())[0];
      const availableAt = new Date('2026-10-26T10:00:00Z');
      tx.printJob.findMany.mockResolvedValue([
        { ...original, status, availableAt, copies: 2, maxAttempts: 5 },
      ]);
      await service.splitKitchenItems(tx as never, split);
      expect(tx.printJob.updateMany).toHaveBeenCalledWith({
        where: { id: 'job', status, updatedAt },
        data: { payload: { items: [item, { ...kept, quantity: 1 }] } },
      });
      expect(tx.printJob.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          status,
          availableAt,
          copies: 2,
          maxAttempts: 5,
          kitchenTicketId: 'ticket',
          deviceId: 'printer',
          requestedById: 'actor',
          deduplicationKey: 'KITCHEN_TICKET:job:SPLIT:destination-session',
          payload: {
            orderSessionId: 'destination-session',
            tableName: 'B2',
            items: [{ ...kept, orderItemId: 'moved', quantity: 1 }],
          },
        }),
      });
    },
  );

  it.each(['PROCESSING', 'PRINTED', 'REQUIRES_REVIEW'])(
    'rejects a partial split of a %s print job',
    async (status) => {
      const original = (await tx.printJob.findMany())[0];
      tx.printJob.findMany.mockResolvedValue([{ ...original, status }]);
      await expect(
        service.splitKitchenItems(tx as never, split),
      ).rejects.toMatchObject({
        response: expect.objectContaining({
          code: 'KITCHEN_SPLIT_REQUIRES_UNPRINTED',
        }),
      });
      expect(tx.printJob.updateMany).not.toHaveBeenCalled();
      expect(tx.printJob.create).not.toHaveBeenCalled();
    },
  );

  it('rejects a split if the printer claims or changes the job before its conditional update', async () => {
    tx.printJob.updateMany.mockResolvedValue({ count: 0 });
    await expect(
      service.splitKitchenItems(tx as never, split),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(tx.printJob.create).not.toHaveBeenCalled();
  });

  it('rejects stale print quantities instead of silently losing a drink', async () => {
    await expect(
      service.splitKitchenItems(tx as never, {
        ...split,
        moves: [{ ...split.moves[0], originalQuantity: 3 }],
      }),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(tx.printJob.updateMany).not.toHaveBeenCalled();
    expect(tx.printJob.create).not.toHaveBeenCalled();
  });

  it('leaves cancelled jobs and whole-line moves untouched', async () => {
    const original = (await tx.printJob.findMany())[0];
    tx.printJob.findMany.mockResolvedValue([
      { ...original, status: 'CANCELLED' },
    ]);
    await service.splitKitchenItems(tx as never, split);
    expect(tx.printJob.updateMany).not.toHaveBeenCalled();
    expect(tx.printJob.create).not.toHaveBeenCalled();
    tx.printJob.findMany.mockClear();
    await service.splitKitchenItems(tx as never, { ...split, moves: [] });
    expect(tx.printJob.findMany).not.toHaveBeenCalled();
  });

  it('treats unspecified printer failure as uncertain, never safe to auto-retry', async () => {
    expect(
      FailPrintJobDto.schema.parse({
        leaseToken: 'x'.repeat(32),
        error: 'Connection lost',
      }).outcome,
    ).toBe('UNKNOWN');
    tx.printJob.findFirst.mockResolvedValue({
      id: 'job',
      attempts: 1,
      maxAttempts: 5,
      leaseTokenHash: 'hash',
    });
    await expect(
      service.failJob('printer', 'job', 'token', 'Connection lost'),
    ).resolves.toEqual({ success: true, retrying: false });
    expect(tx.printJob.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: 'REQUIRES_REVIEW',
          leaseTokenHash: 'hash',
          failedAt: null,
        }),
      }),
    );
  });

  it('audits operator confirmation without immediately printing again', async () => {
    tx.printJob.findUnique.mockResolvedValue({
      id: 'job',
      status: 'REQUIRES_REVIEW',
      deviceId: 'printer',
      updatedAt,
    });
    await service.resolveJob('job', 'actor', {
      outcome: 'NOT_PRINTED',
      reason: 'Checked paper and stopped agent',
      expectedUpdatedAt: updatedAt.toISOString(),
    });
    expect(tx.printJob.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: 'FAILED',
          leaseTokenHash: null,
        }),
      }),
    );
    expect(tx.actionLog.create).toHaveBeenCalledWith({
      data: {
        employeeId: 'actor',
        actionType: 'PRINT_JOB_RESOLVED',
        details: {
          printJobId: 'job',
          outcome: 'NOT_PRINTED',
          reason: 'Checked paper and stopped agent',
        },
      },
    });
  });

  it('rejects stale operator confirmation', async () => {
    tx.printJob.findUnique.mockResolvedValue({
      id: 'job',
      status: 'PRINTED',
      updatedAt,
    });
    await expect(
      service.resolveJob('job', 'actor', {
        outcome: 'NOT_PRINTED',
        reason: 'Checked',
        expectedUpdatedAt: updatedAt.toISOString(),
      }),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(tx.actionLog.create).not.toHaveBeenCalled();
  });

  it('never requeues cancelled items when an agent confirms it printed nothing', async () => {
    tx.printJob.findFirst.mockResolvedValue({
      id: 'job',
      type: 'KITCHEN_TICKET',
      attempts: 1,
      maxAttempts: 5,
      leaseTokenHash: 'hash',
      payload: { items: [item] },
      kitchenTicket: { items: [{ orderItemId: 'cancelled' }] },
    });
    await expect(
      service.failJob(
        'printer',
        'job',
        'token',
        'Printer offline',
        'NOT_PRINTED',
      ),
    ).resolves.toEqual({ success: true, retrying: false });
    expect(tx.printJob.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: 'CANCELLED',
          payload: { items: [] },
        }),
      }),
    );
  });

  it('does not overlap recovery ticks and drains the running tick during shutdown', async () => {
    let finish!: () => void;
    const printing = {
      recoverExpiredLeases: jest.fn(
        () =>
          new Promise<void>((resolve) => {
            finish = resolve;
          }),
      ),
    };
    const worker = new PrintLeaseRecoveryService(
      new ConfigService({ NODE_ENV: 'test' }),
      printing as never,
    );
    const first = worker.run();
    expect(worker.run()).toBe(first);
    expect(printing.recoverExpiredLeases).toHaveBeenCalledTimes(1);
    const stopped = worker.onModuleDestroy();
    finish();
    await stopped;
    await first;
  });
});
