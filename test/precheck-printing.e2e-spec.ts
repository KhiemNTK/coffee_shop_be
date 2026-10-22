import { randomUUID } from 'node:crypto';
import { PrismaClient, PrintDeviceType, PrintJobType } from '@prisma/client';
import { IdempotencyService } from '../src/app/durable/idempotency.service';
import { InvoicePolicyService } from '../src/app/invoices/invoice-policy.service';
import { InvoicesService } from '../src/app/invoices/invoices.service';
import { PrintingService } from '../src/app/printing/printing.service';
import { PaginationUtilService } from '../src/common/utils/pagination-util/pagination-util.service';

describe('Pre-check transaction integrity (PostgreSQL)', () => {
  const prisma = new PrismaClient();
  const prefix = `precheck-${randomUUID()}`;
  const ids: Record<string, string> = {};
  const serviceFor = (client: object) => {
    const idempotency = new IdempotencyService(client as never);
    const invoices = new InvoicesService(
      client as never,
      {} as never,
      {} as never,
      new InvoicePolicyService(),
      {} as never,
      idempotency,
      {} as never,
      {} as never,
      {} as never,
    );
    return new PrintingService(
      client as never,
      new PaginationUtilService(),
      idempotency,
      invoices,
    );
  };

  beforeAll(async () => {
    const position = await prisma.position.create({
      data: { name: prefix, salary: 0 },
    });
    ids.position = position.id;
    const employee = await prisma.employee.create({
      data: {
        positionId: position.id,
        email: `${prefix}@example.test`,
        username: prefix,
        fullName: 'Precheck cashier',
        password: 'not-used-by-test',
      },
    });
    ids.employee = employee.id;
    const category = await prisma.menuCategory.create({
      data: { name: prefix },
    });
    ids.category = category.id;
    const menu = await prisma.menuItem.create({
      data: { name: prefix, categoryId: category.id, price: 25000 },
    });
    ids.menu = menu.id;
    const session = await prisma.orderSession.create({
      data: { employeeId: employee.id },
    });
    ids.session = session.id;
    const billed = await prisma.invoice.create({
      data: {
        invoiceNumber: prefix,
        orderSessionId: session.id,
        employeeId: employee.id,
        subTotal: 25000,
        totalAmount: 25000,
      },
    });
    ids.invoice = billed.id;
    const item = await prisma.orderItem.create({
      data: {
        orderSessionId: session.id,
        menuItemId: menu.id,
        quantity: 2,
        priceAtTime: 25000,
      },
    });
    ids.item = item.id;
    await prisma.orderItem.createMany({
      data: [
        {
          orderSessionId: session.id,
          menuItemId: menu.id,
          quantity: 1,
          priceAtTime: 25000,
          serveStatus: 'CANCELLED',
        },
        {
          orderSessionId: session.id,
          menuItemId: menu.id,
          quantity: 1,
          priceAtTime: 25000,
          invoiceId: billed.id,
        },
      ],
    });
  });

  afterAll(async () => {
    try {
      if (ids.employee) {
        await prisma.printJob.deleteMany({
          where: { requestedById: ids.employee },
        });
        await prisma.$transaction(async (tx) => {
          await tx.$queryRaw`SELECT set_config('app.allow_audit_log_mutation', 'on', true)`;
          await tx.actionLog.deleteMany({
            where: { employeeId: ids.employee },
          });
        });
        await prisma.idempotencyRequest.deleteMany({
          where: { employeeId: ids.employee },
        });
      }
      if (ids.session) {
        await prisma.orderItem.deleteMany({
          where: { orderSessionId: ids.session },
        });
        await prisma.invoice.deleteMany({
          where: { orderSessionId: ids.session },
        });
        await prisma.orderSession.deleteMany({ where: { id: ids.session } });
      }
      if (ids.menu)
        await prisma.menuItem.deleteMany({ where: { id: ids.menu } });
      if (ids.category)
        await prisma.menuCategory.deleteMany({ where: { id: ids.category } });
      await prisma.printDevice.deleteMany({ where: { name: prefix } });
      if (ids.employee)
        await prisma.employee.deleteMany({ where: { id: ids.employee } });
      if (ids.position)
        await prisma.position.deleteMany({ where: { id: ids.position } });
    } finally {
      await prisma.$disconnect();
    }
  });

  it('deduplicates concurrent printing, excludes cancelled/billed items and preserves the snapshot', async () => {
    const service = serviceFor(prisma);
    const request = {
      orderSessionId: ids.session,
      copies: 1,
      idempotencyKey: randomUUID(),
    };
    const [first, second] = await Promise.all([
      service.createPrecheck(ids.employee, request),
      service.createPrecheck(ids.employee, request),
    ]);
    expect(first.id).toBe(second.id);
    expect(
      await prisma.printJob.count({ where: { requestedById: ids.employee } }),
    ).toBe(1);
    const job = await prisma.printJob.findUniqueOrThrow({
      where: { id: first.id },
    });
    expect(job.invoiceId).toBeNull();
    expect(job.payload).toMatchObject({
      documentType: 'PRECHECK',
      paymentStatus: 'UNPAID',
      totalAmount: '50000',
      items: [
        {
          orderItemId: ids.item,
          name: prefix,
          quantity: 2,
          unitPrice: '25000',
          lineTotal: '50000',
        },
      ],
    });
    expect(
      await prisma.invoice.count({ where: { orderSessionId: ids.session } }),
    ).toBe(1);
    expect(
      await prisma.orderItem.findUnique({ where: { id: ids.item } }),
    ).toMatchObject({ isPaid: false, invoiceId: null });
    expect(
      await prisma.orderSession.findUnique({ where: { id: ids.session } }),
    ).toMatchObject({ sessionStatus: 'ACTIVE' });
    await prisma.menuItem.update({
      where: { id: ids.menu },
      data: { name: `${prefix}-renamed`, price: 42000 },
    });
    expect((await service.createPrecheck(ids.employee, request)).id).toBe(
      first.id,
    );
    expect(
      (await prisma.printJob.findUniqueOrThrow({ where: { id: first.id } }))
        .payload,
    ).toEqual(job.payload);
    await expect(
      service.createPrecheck(ids.employee, { ...request, copies: 2 }),
    ).rejects.toThrow('different request');
  });

  it('rolls back both job and idempotency record if the audit write fails', async () => {
    const client = prisma.$extends({
      query: {
        actionLog: {
          create: () => {
            throw new Error('Audit storage unavailable');
          },
        },
      },
    });
    const key = randomUUID();
    const before = await prisma.printJob.count({
      where: { requestedById: ids.employee },
    });
    await expect(
      serviceFor(client).createPrecheck(ids.employee, {
        orderSessionId: ids.session,
        copies: 1,
        idempotencyKey: key,
      }),
    ).rejects.toThrow('Audit storage unavailable');
    expect(
      await prisma.printJob.count({ where: { requestedById: ids.employee } }),
    ).toBe(before);
    expect(
      await prisma.idempotencyRequest.count({
        where: { employeeId: ids.employee, key },
      }),
    ).toBe(0);
  });

  it('assigns pending pre-checks to a receipt device and lets the agent claim the typed snapshot', async () => {
    const service = serviceFor(prisma);
    const waiting = await service.createPrecheck(ids.employee, {
      orderSessionId: ids.session,
      copies: 1,
      idempotencyKey: randomUUID(),
    });
    await prisma.printJob.update({
      where: { id: waiting.id },
      data: { deviceId: null },
    });
    const created = await service.createDevice(ids.employee, {
      name: prefix,
      type: PrintDeviceType.RECEIPT,
      paperSize: '80mm',
      isDefault: true,
    });
    const claimed = await service.claimJobs(
      { id: created.device.id, type: PrintDeviceType.RECEIPT, status: 'READY' },
      { limit: 10 },
    );
    expect(claimed.jobs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: PrintJobType.PRECHECK,
          id: waiting.id,
          payload: expect.objectContaining({
            documentType: 'PRECHECK',
            paymentStatus: 'UNPAID',
          }),
        }),
      ]),
    );
  });
});
