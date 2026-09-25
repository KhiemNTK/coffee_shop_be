import { ConflictException } from '@nestjs/common';
import {
  PrintDeviceStatus,
  PrintDeviceType,
  PrintJobStatus,
  PrintJobType,
} from '@prisma/client';
import { PaginationUtilService } from '../../common/utils/pagination-util/pagination-util.service';
import { PrintingService } from './printing.service';

describe('PrintingService leases', () => {
  const createService = (prisma: object) =>
    new PrintingService(
      prisma as never,
      new PaginationUtilService(),
      {} as never,
    );

  it('projects admin jobs without lease hashes, deduplication keys, or list payloads', async () => {
    const prisma = {
      printJob: {
        count: jest.fn().mockResolvedValue(0),
        findMany: jest.fn().mockResolvedValue([]),
        findUnique: jest.fn().mockResolvedValue({ id: 'job-id' }),
      },
    };
    const service = createService(prisma);

    await service.getJobs({} as never);
    await service.getJob('job-id');

    const listSelect = prisma.printJob.findMany.mock.calls[0][0].select;
    const detailSelect = prisma.printJob.findUnique.mock.calls[0][0].select;
    for (const select of [listSelect, detailSelect]) {
      expect(select).not.toHaveProperty('leaseTokenHash');
      expect(select).not.toHaveProperty('deduplicationKey');
    }
    expect(listSelect.payload).toBe(false);
    expect(detailSelect.payload).toBe(true);
  });

  it('does not unpause a device from a stale agent context', async () => {
    const prisma = {
      printDevice: {
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
        findFirst: jest.fn().mockResolvedValue({
          id: 'device-id',
          isActive: true,
          status: PrintDeviceStatus.PAUSED,
          lastSeenAt: new Date(),
        }),
      },
    };
    const service = createService(prisma);
    const device = {
      id: 'device-id',
      type: PrintDeviceType.RECEIPT,
      status: PrintDeviceStatus.READY,
    };

    const result = await service.heartbeat(device, {
      status: PrintDeviceStatus.READY,
    });

    expect(result.status).toBe(PrintDeviceStatus.PAUSED);
    expect(prisma.printDevice.updateMany).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        where: expect.objectContaining({
          status: { not: PrintDeviceStatus.PAUSED },
        }),
      }),
    );
    expect(prisma.printDevice.updateMany).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ data: { lastSeenAt: expect.any(Date) } }),
    );
  });

  it('rejects claiming jobs when the database device state is not ready', async () => {
    const tx = { $queryRaw: jest.fn().mockResolvedValue([]) };
    const prisma = { $transaction: jest.fn((callback) => callback(tx)) };
    const service = createService(prisma);

    await expect(
      service.claimJobs(
        {
          id: 'device-id',
          type: PrintDeviceType.RECEIPT,
          status: PrintDeviceStatus.READY,
        },
        { limit: 1 },
      ),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(tx.$queryRaw).toHaveBeenCalledTimes(1);
  });

  it('rejects completion when the lease token is stale', async () => {
    const prisma = {
      printJob: { updateMany: jest.fn().mockResolvedValue({ count: 0 }) },
    };
    const service = createService(prisma);

    await expect(
      service.completeJob('device-id', 'job-id', 'stale-token'),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('moves an exhausted failed lease to terminal failed state', async () => {
    const tx = {
      printJob: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'job-id',
          type: PrintJobType.RECEIPT,
          status: PrintJobStatus.PROCESSING,
          attempts: 5,
          maxAttempts: 5,
          leaseTokenHash: expect.any(String),
        }),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
    };
    const prisma = {
      $transaction: jest.fn((callback) => callback(tx)),
    };
    const service = createService(prisma);

    await expect(
      service.failJob('device-id', 'job-id', 'valid-token-value', 'offline'),
    ).resolves.toEqual({ success: true, retrying: false });
    expect(tx.printJob.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: PrintJobStatus.FAILED,
          failedAt: expect.any(Date),
        }),
      }),
    );
  });
});
