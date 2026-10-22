import { ConflictException } from '@nestjs/common';
import { Prisma, PrintJobType } from '@prisma/client';
import { PaginationUtilService } from '../../common/utils/pagination-util/pagination-util.service';
import { CreatePrecheckDto } from './dto';
import { PrintingService } from './printing.service';

describe('Pre-check printing', () => {
  const sessionId = '91000000-0000-4000-8000-000000000001';
  const itemId = '91000000-0000-4000-8000-000000000002';
  const dto = CreatePrecheckDto.schema.parse({
    orderSessionId: sessionId,
    orderItemIds: [itemId],
    idempotencyKey: 'precheck-test-key',
  });
  const setup = () => {
    const tx = {
      orderSession: {
        findUniqueOrThrow: jest
          .fn()
          .mockResolvedValue({ table: { name: 'Table 1' } }),
      },
      employee: {
        findUniqueOrThrow: jest.fn().mockResolvedValue({ fullName: 'Cashier' }),
      },
      orderItem: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: itemId,
            quantity: 2,
            priceAtTime: new Prisma.Decimal('25000'),
            selectedOptions: [],
            menuItem: { name: 'Latte' },
          },
        ]),
        updateMany: jest.fn(),
      },
      invoice: { create: jest.fn() },
      printDevice: { findFirst: jest.fn().mockResolvedValue(null) },
      printJob: {
        create: jest
          .fn()
          .mockResolvedValue({ id: 'job-id', type: PrintJobType.PRECHECK }),
      },
      actionLog: { create: jest.fn() },
    };
    const invoices = {
      quoteInvoiceInTransaction: jest.fn().mockResolvedValue({
        orderItemIds: [itemId],
        subTotal: new Prisma.Decimal('50000'),
        discountAmount: new Prisma.Decimal('5000'),
        taxAmount: new Prisma.Decimal('4500'),
        taxRate: new Prisma.Decimal('10'),
        totalAmount: new Prisma.Decimal('49500'),
      }),
    };
    const idempotency = {
      execute: jest.fn((_input, operation) => operation(tx)),
    };
    const service = new PrintingService(
      {} as never,
      new PaginationUtilService(),
      idempotency as never,
      invoices as never,
    );
    return { service, tx, invoices, idempotency };
  };

  it('takes a server quote, snapshot, job and audit in the same transaction without settling items', async () => {
    const { service, tx, invoices, idempotency } = setup();
    await service.createPrecheck('employee-id', dto);
    expect(invoices.quoteInvoiceInTransaction).toHaveBeenCalledWith(
      tx,
      'employee-id',
      dto,
    );
    expect(idempotency.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        employeeId: 'employee-id',
        operation: 'printing.precheck',
        key: dto.idempotencyKey,
      }),
      expect.any(Function),
    );
    expect(tx.printJob.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          type: PrintJobType.PRECHECK,
          deviceId: null,
          copies: 1,
          payload: expect.objectContaining({
            documentType: 'PRECHECK',
            paymentStatus: 'UNPAID',
            tableName: 'Table 1',
            totalAmount: '49500',
            discountAmount: '5000',
            taxAmount: '4500',
            items: [
              expect.objectContaining({
                name: 'Latte',
                quantity: 2,
                unitPrice: '25000',
                lineTotal: '50000',
              }),
            ],
          }),
        }),
      }),
    );
    expect(tx.invoice.create).not.toHaveBeenCalled();
    expect(tx.orderItem.updateMany).not.toHaveBeenCalled();
    expect(tx.actionLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          actionType: 'PRECHECK_PRINT_REQUESTED',
        }),
      }),
    );
  });

  it('does not enqueue a pre-check if the authoritative quote rejects changed items', async () => {
    const { service, tx, invoices } = setup();
    invoices.quoteInvoiceInTransaction.mockRejectedValue(
      new ConflictException('Item already invoiced'),
    );
    await expect(service.createPrecheck('employee-id', dto)).rejects.toThrow(
      ConflictException,
    );
    expect(tx.printJob.create).not.toHaveBeenCalled();
    expect(tx.actionLog.create).not.toHaveBeenCalled();
  });

  it('rejects kitchen printers for pre-check jobs', async () => {
    const { service, tx } = setup();
    tx.printDevice.findFirst.mockResolvedValue(null);
    await expect(
      service.createPrecheck('employee-id', { ...dto, deviceId: itemId }),
    ).rejects.toThrow(ConflictException);
    expect(tx.printDevice.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: itemId, type: 'RECEIPT' }),
      }),
    );
    expect(tx.printJob.create).not.toHaveBeenCalled();
  });

  it('rejects client totals, oversized requests and missing idempotency keys at the boundary', () => {
    expect(
      CreatePrecheckDto.schema.safeParse({ ...dto, totalAmount: '1' }).success,
    ).toBe(false);
    expect(
      CreatePrecheckDto.schema.safeParse({ ...dto, copies: 6 }).success,
    ).toBe(false);
    expect(
      CreatePrecheckDto.schema.safeParse({
        ...dto,
        orderItemIds: Array(301).fill(itemId),
      }).success,
    ).toBe(false);
    expect(
      CreatePrecheckDto.schema.safeParse({ orderSessionId: sessionId }).success,
    ).toBe(false);
  });
});
