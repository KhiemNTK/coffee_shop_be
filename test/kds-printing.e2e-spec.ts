import { randomUUID } from 'node:crypto';
import {
  PrismaClient,
  PrintDeviceStatus,
  PrintDeviceType,
  PrintJobStatus,
  PrintJobType,
} from '@prisma/client';
import { ConflictException } from '@nestjs/common';
import type { AuthenticatedPrintDevice } from '../src/common/types';
import { PrintingService } from '../src/app/printing/printing.service';
import { PaginationUtilService } from '../src/common/utils/pagination-util/pagination-util.service';

describe('KDS printing claims (e2e)', () => {
  const prisma = new PrismaClient();
  const printing = new PrintingService(
    prisma as never,
    new PaginationUtilService(),
    {} as never,
  );
  const suffix = randomUUID();
  const ids: Record<string, string> = {};

  beforeAll(async () => {
    const position = await prisma.position.create({
      data: { name: `Print position ${suffix}`, salary: 0 },
    });
    ids.position = position.id;
    const employee = await prisma.employee.create({
      data: {
        email: `print-${suffix}@example.com`,
        username: `print-${suffix}`,
        fullName: 'Print Test Employee',
        password: 'not-used-in-print-tests',
        positionId: position.id,
      },
    });
    ids.employee = employee.id;
    const menuCategory = await prisma.menuCategory.create({
      data: { name: `Print category ${suffix}` },
    });
    ids.menuCategory = menuCategory.id;
    const menuItem = await prisma.menuItem.create({
      data: {
        name: `Print item ${suffix}`,
        price: 25_000,
        categoryId: menuCategory.id,
      },
    });
    ids.menuItem = menuItem.id;
    const session = await prisma.orderSession.create({
      data: { employeeId: employee.id },
    });
    ids.session = session.id;
    const orderItem = await prisma.orderItem.create({
      data: {
        orderSessionId: session.id,
        menuItemId: menuItem.id,
        quantity: 1,
        priceAtTime: menuItem.price,
      },
    });
    ids.orderItem = orderItem.id;
    const device = await prisma.printDevice.create({
      data: {
        name: `Kitchen printer ${suffix}`,
        type: PrintDeviceType.KITCHEN,
        paperSize: '80mm',
        apiKeyHash: 'a'.repeat(64),
      },
    });
    ids.device = device.id;
    const station = await prisma.kitchenStation.create({
      data: {
        code: `K-${suffix}`,
        name: `Kitchen ${suffix}`,
        printDeviceId: device.id,
      },
    });
    ids.station = station.id;
    const ticket = await prisma.kitchenTicket.create({
      data: {
        stationId: station.id,
        orderSessionId: session.id,
        dueAt: new Date(Date.now() + 5 * 60_000),
        items: {
          create: {
            orderItemId: orderItem.id,
            itemName: menuItem.name,
            quantity: 1,
          },
        },
      },
    });
    ids.ticket = ticket.id;
    const job = await prisma.printJob.create({
      data: {
        type: PrintJobType.KITCHEN_TICKET,
        payload: { ticketId: ticket.id },
        deviceId: device.id,
        kitchenTicketId: ticket.id,
      },
    });
    ids.job = job.id;
  });

  afterAll(async () => {
    try {
      await prisma.printJob.deleteMany({ where: { id: ids.job } });
      await prisma.kitchenTicketItem.deleteMany({
        where: { ticketId: ids.ticket },
      });
      await prisma.kitchenTicket.deleteMany({ where: { id: ids.ticket } });
      await prisma.kitchenStation.deleteMany({ where: { id: ids.station } });
      await prisma.printDevice.deleteMany({ where: { id: ids.device } });
      await prisma.orderItem.deleteMany({ where: { id: ids.orderItem } });
      await prisma.orderSession.deleteMany({ where: { id: ids.session } });
      await prisma.menuItem.deleteMany({ where: { id: ids.menuItem } });
      await prisma.menuCategory.deleteMany({ where: { id: ids.menuCategory } });
      await prisma.employee.deleteMany({ where: { id: ids.employee } });
      await prisma.position.deleteMany({ where: { id: ids.position } });
    } finally {
      await prisma.$disconnect();
    }
  });

  it('leases a job to only one concurrent claimant and rejects stale ack', async () => {
    const device: AuthenticatedPrintDevice = {
      id: ids.device,
      type: PrintDeviceType.KITCHEN,
      status: PrintDeviceStatus.READY,
    };
    const claims = await Promise.all([
      printing.claimJobs(device, { limit: 10 }),
      printing.claimJobs(device, { limit: 10 }),
    ]);
    const jobs = claims.flatMap((claim) => claim.jobs);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.id).toBe(ids.job);

    await expect(
      printing.completeJob(
        ids.device,
        ids.job,
        'stale-lease-token-that-cannot-match',
      ),
    ).rejects.toBeInstanceOf(ConflictException);
    await expect(
      printing.completeJob(ids.device, ids.job, jobs[0].leaseToken),
    ).resolves.toEqual({ success: true });

    const persisted = await prisma.printJob.findUniqueOrThrow({
      where: { id: ids.job },
    });
    expect(persisted.status).toBe(PrintJobStatus.PRINTED);
    expect(persisted.attempts).toBe(1);
    expect(persisted.printedAt).toBeInstanceOf(Date);
  });

  it('omits lease secrets from management responses', async () => {
    const detail = await printing.getJob(ids.job);
    expect(detail).not.toHaveProperty('leaseTokenHash');
    expect(detail).not.toHaveProperty('deduplicationKey');

    const page = await printing.getJobs({ page: 1, itemPerPage: 10 });
    const listed = page.list.find((job) => job.id === ids.job);
    expect(listed).toBeDefined();
    expect(listed).not.toHaveProperty('leaseTokenHash');
    expect(listed).not.toHaveProperty('deduplicationKey');
    expect(listed).not.toHaveProperty('payload');
  });

  it('rejects claims after a device is paused, even with a stale guard context', async () => {
    await prisma.printDevice.update({
      where: { id: ids.device },
      data: { status: PrintDeviceStatus.PAUSED },
    });
    const staleContext: AuthenticatedPrintDevice = {
      id: ids.device,
      type: PrintDeviceType.KITCHEN,
      status: PrintDeviceStatus.READY,
    };
    await expect(
      printing.claimJobs(staleContext, { limit: 10 }),
    ).rejects.toBeInstanceOf(ConflictException);
    await printing.heartbeat(staleContext, {
      status: PrintDeviceStatus.READY,
    });
    const device = await prisma.printDevice.findUniqueOrThrow({
      where: { id: ids.device },
    });
    expect(device.status).toBe(PrintDeviceStatus.PAUSED);
  });
});
