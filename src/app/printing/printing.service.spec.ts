import { ConflictException } from '@nestjs/common';
import {
  PaymentStatus,
  Prisma,
  PrintDeviceStatus,
  PrintDeviceType,
  PrintJobStatus,
  PrintJobType,
} from '@prisma/client';
import type { ReceiptPrintPayload } from '../../common/types';
import { PaginationUtilService } from '../../common/utils/pagination-util/pagination-util.service';
import { PrintingService } from './printing.service';
import { GetPrintDevicesDto } from './dto';

describe('PrintingService leases', () => {
  const createService = (prisma: object) =>
    new PrintingService(
      prisma as never,
      new PaginationUtilService(),
      {} as never,
      {} as never,
    );

  it('searches devices before paging without exposing agent credentials', async () => {
    const prisma = {
      printDevice: {
        count: jest.fn().mockResolvedValue(51),
        findMany: jest.fn().mockResolvedValue([]),
      },
    };
    const query = GetPrintDevicesDto.schema.parse({
      page: 2,
      itemPerPage: 50,
      keyword: '  Bếp  ',
      type: 'KITCHEN',
      isActive: 'false',
    });
    const result = await createService(prisma).getDevices(query);
    const where = {
      deletedAt: null,
      name: { contains: 'Bếp', mode: 'insensitive' },
      type: PrintDeviceType.KITCHEN,
      isActive: false,
    };
    expect(prisma.printDevice.count).toHaveBeenCalledWith({ where });
    expect(prisma.printDevice.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where, skip: 50, take: 50 }),
    );
    expect(
      prisma.printDevice.findMany.mock.calls[0][0].select,
    ).not.toHaveProperty('apiKeyHash');
    expect(result).toMatchObject({
      currentPage: 2,
      totalItems: 51,
      totalPages: 2,
    });
  });

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

  it('cannot release a future kitchen ticket early through admin retry', async () => {
    const availableAt = new Date(Date.now() + 60_000);
    const tx = {
      employee: { findFirst: jest.fn().mockResolvedValue({ id: 'employee' }) },
      printJob: {
        findUnique: jest.fn().mockResolvedValue({
          status: PrintJobStatus.PENDING,
          deviceId: null,
          kitchenTicket: { availableAt },
        }),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        findUniqueOrThrow: jest.fn().mockResolvedValue({}),
      },
      actionLog: { create: jest.fn() },
    };
    const service = createService({ $transaction: jest.fn((fn) => fn(tx)) });
    await service.retryJob('job', 'employee', {});
    expect(tx.printJob.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ availableAt }),
      }),
    );
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

describe('PrintingService receipt reprints', () => {
  const originalPayload: ReceiptPrintPayload = {
    isReprint: false,
    invoiceId: 'invoice-id',
    invoiceNumber: 'RECEIPT-001',
    createdAt: '2026-01-01T06:00:00.000Z',
    tableName: 'Table 1',
    cashierName: 'Original cashier',
    paymentMethod: 'CASH',
    paymentStatus: 'PAID',
    subTotal: '50000',
    discountAmount: '0',
    taxAmount: '0',
    totalAmount: '50000',
    amountTendered: null,
    changeAmount: null,
    items: [
      {
        orderItemId: 'item-id',
        name: 'Original coffee',
        quantity: 2,
        unitPrice: '25000',
        lineTotal: '50000',
        selectedOptions: [],
      },
    ],
  };
  const dto = {
    reason: 'Customer requested another copy',
    copies: 2,
    idempotencyKey: 'reprint-key',
  };
  const tx = {
    employee: { findFirst: jest.fn() },
    invoice: { findFirst: jest.fn() },
    printDevice: { findFirst: jest.fn() },
    printJob: { findFirst: jest.fn(), create: jest.fn() },
    actionLog: { create: jest.fn() },
  };
  const idempotency = { execute: jest.fn() };
  let service: PrintingService;

  beforeEach(() => {
    jest.clearAllMocks();
    idempotency.execute.mockImplementation(
      (_input: unknown, operation: (client: typeof tx) => Promise<unknown>) =>
        operation(tx),
    );
    tx.employee.findFirst.mockResolvedValue({ id: 'employee-id' });
    tx.invoice.findFirst.mockResolvedValue({
      ...originalPayload,
      id: originalPayload.invoiceId,
      createdAt: new Date(originalPayload.createdAt),
      paymentStatus: PaymentStatus.PARTIALLY_REFUNDED,
      orderSession: { table: { name: 'Table 2' } },
      employee: { fullName: 'Renamed cashier' },
      subTotal: new Prisma.Decimal(50000),
      discountAmount: new Prisma.Decimal(0),
      taxAmount: new Prisma.Decimal(0),
      totalAmount: new Prisma.Decimal(50000),
      orderItems: [
        {
          id: 'item-id',
          quantity: 2,
          priceAtTime: new Prisma.Decimal(25000),
          selectedOptions: [],
          menuItem: { name: 'Renamed coffee' },
        },
      ],
    });
    tx.printDevice.findFirst.mockResolvedValue({ id: 'device-id' });
    tx.printJob.findFirst.mockResolvedValue({
      id: 'original-id',
      payload: originalPayload,
    });
    tx.printJob.create.mockImplementation(({ data }) =>
      Promise.resolve({ id: 'reprint-id', ...data }),
    );
    service = new PrintingService(
      {} as never,
      new PaginationUtilService(),
      idempotency as never,
      {} as never,
    );
  });

  it.each([
    PrintJobStatus.PENDING,
    PrintJobStatus.FAILED,
    PrintJobStatus.PRINTED,
  ])(
    'preserves the %s original receipt after menu, table, and cashier renames',
    async (status) => {
      tx.printJob.findFirst.mockResolvedValue({
        id: 'original-id',
        payload: originalPayload,
        status,
      });
      const result = await service.reprintReceipt(
        'invoice-id',
        'employee-id',
        dto,
      );

      expect(result).toMatchObject({
        reprintOfId: 'original-id',
        copies: dto.copies,
        deviceId: 'device-id',
        requestedById: 'employee-id',
      });
      expect(result.payload).toEqual({ ...originalPayload, isReprint: true });
      expect(originalPayload.isReprint).toBe(false);
      expect(tx.printJob.findFirst).toHaveBeenCalledWith({
        where: {
          invoiceId: 'invoice-id',
          type: PrintJobType.RECEIPT,
          reprintOfId: null,
        },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        select: { id: true, payload: true },
      });
    },
  );

  it.each([
    null,
    { id: 'original-id', payload: null },
    { id: 'original-id', payload: 'legacy' },
    { id: 'original-id', payload: [] },
  ])(
    'builds a meaningful fallback when no original receipt object exists (%j)',
    async (original) => {
      tx.printJob.findFirst.mockResolvedValue(original);

      const result = await service.reprintReceipt(
        'invoice-id',
        'employee-id',
        dto,
      );

      expect(result.payload).toEqual({
        ...originalPayload,
        isReprint: true,
        tableName: 'Table 2',
        cashierName: 'Renamed cashier',
        paymentStatus: PaymentStatus.PARTIALLY_REFUNDED,
        items: [
          {
            orderItemId: 'item-id',
            name: 'Renamed coffee',
            quantity: 2,
            unitPrice: '25000',
            lineTotal: '50000',
            selectedOptions: [],
          },
        ],
      });
      expect(result.reprintOfId).toBe(original?.id);
    },
  );

  it('still rejects unpaid invoices when an original receipt exists', async () => {
    tx.invoice.findFirst.mockResolvedValue(null);

    await expect(
      service.reprintReceipt('invoice-id', 'employee-id', dto),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(tx.printJob.create).not.toHaveBeenCalled();
  });

  it('builds a first receipt from the immutable document, not renamed live rows', async () => {
    tx.printJob.findFirst.mockResolvedValue(null);
    const invoice = await tx.invoice.findFirst();
    tx.invoice.findFirst.mockResolvedValue({
      ...invoice,
      documentSnapshot: {
        version: 1,
        source: 'ISSUED',
        tableId: 'original-table',
        tableName: 'Original table',
        issuedByName: 'Invoice issuer',
        promotionName: null,
        items: [
          {
            orderItemId: 'item-id',
            menuItemId: 'menu-id',
            name: 'Original coffee',
            quantity: 2,
            unitPrice: '25000.00',
            note: null,
            selectedOptions: [],
          },
        ],
      },
    });
    const result = await service.reprintReceipt(
      'invoice-id',
      'employee-id',
      dto,
    );
    expect(result.payload).toMatchObject({
      tableName: 'Original table',
      cashierName: 'Renamed cashier',
      items: [
        {
          name: 'Original coffee',
          unitPrice: '25000.00',
          lineTotal: '50000.00',
        },
      ],
    });
  });
});
