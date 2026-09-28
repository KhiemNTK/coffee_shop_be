import { randomUUID } from 'node:crypto';
import { PrismaClient, ServeStatus } from '@prisma/client';
import { KitchenService } from '../src/app/kitchen/kitchen.service';
import { ReportsService } from '../src/app/reports/reports.service';
import type { ExtendedPrismaClient } from '../src/common/prisma/prisma.service';
import { ExcelUtilService } from '../src/common/utils/excel-util/excel-util.service';
import { PaginationUtilService } from '../src/common/utils/pagination-util/pagination-util.service';

describe('Kitchen bottlenecks (e2e)', () => {
  const prisma = new PrismaClient();
  const suffix = randomUUID();
  const service = new ReportsService(
    prisma as unknown as ExtendedPrismaClient,
    new ExcelUtilService(),
  );
  const kitchen = new KitchenService(
    prisma as unknown as ExtendedPrismaClient,
    new PaginationUtilService(),
  );
  const ids: Record<string, string> = {};
  const period = {
    from: new Date('2026-06-01T00:00:00.000Z'),
    to: new Date('2026-06-02T00:00:00.000Z'),
    timeZone: 'Asia/Ho_Chi_Minh',
  };

  beforeAll(async () => {
    const position = await prisma.position.create({
      data: { name: `Bottleneck position ${suffix}`, salary: 0 },
    });
    ids.position = position.id;
    const employee = await prisma.employee.create({
      data: {
        email: `bottleneck-${suffix}@example.com`,
        username: `bottleneck-${suffix}`,
        fullName: 'Kitchen reporter',
        password: 'test-only',
        positionId: position.id,
      },
    });
    ids.employee = employee.id;
    const category = await prisma.menuCategory.create({
      data: { name: `Bottleneck category ${suffix}` },
    });
    ids.category = category.id;
    const menuItem = await prisma.menuItem.create({
      data: {
        name: `Bottleneck item ${suffix}`,
        categoryId: category.id,
        price: 1,
      },
    });
    ids.menuItem = menuItem.id;
    const bar = await prisma.kitchenStation.create({
      data: { code: `BAR-${suffix}`, name: `Bar ${suffix}` },
    });
    ids.bar = bar.id;
    const food = await prisma.kitchenStation.create({
      data: { code: `FOOD-${suffix}`, name: `Food ${suffix}` },
    });
    ids.food = food.id;
    const session = await prisma.orderSession.create({
      data: { employeeId: employee.id },
    });
    ids.session = session.id;
    const now = Date.now();

    const tickets: Array<{
      key?: string;
      stationId: string;
      createdAt: string;
      dueAt: string;
      readyAt?: string;
      status: ServeStatus;
      quantity: number;
    }> = [
      {
        stationId: bar.id,
        createdAt: '2026-06-01T01:10:00Z',
        dueAt: '2026-06-01T01:20:00Z',
        readyAt: '2026-06-01T01:15:00Z',
        status: ServeStatus.READY,
        quantity: 2,
      },
      {
        stationId: bar.id,
        createdAt: '2026-06-01T01:20:00Z',
        dueAt: '2026-06-01T01:25:00Z',
        readyAt: '2026-06-01T01:30:00Z',
        status: ServeStatus.READY,
        quantity: 1,
      },
      {
        stationId: bar.id,
        createdAt: '2026-06-01T01:25:00Z',
        dueAt: '2026-06-01T01:35:00Z',
        status: ServeStatus.PENDING,
        quantity: 3,
      },
      {
        stationId: bar.id,
        createdAt: '2026-06-01T01:40:00Z',
        dueAt: '2026-06-01T01:50:00Z',
        status: ServeStatus.CANCELLED,
        quantity: 1,
      },
      {
        stationId: bar.id,
        createdAt: '2026-06-01T02:10:00Z',
        dueAt: '2026-06-01T02:20:00Z',
        readyAt: '2026-06-01T02:13:00Z',
        status: ServeStatus.READY,
        quantity: 1,
      },
      {
        stationId: food.id,
        createdAt: '2026-06-01T01:15:00Z',
        dueAt: '2026-06-01T01:30:00Z',
        readyAt: '2026-06-01T01:22:00Z',
        status: ServeStatus.READY,
        quantity: 2,
      },
      {
        stationId: bar.id,
        createdAt: '2025-11-02T05:15:00Z',
        dueAt: '2025-11-02T05:30:00Z',
        readyAt: '2025-11-02T05:20:00Z',
        status: ServeStatus.READY,
        quantity: 1,
      },
      {
        stationId: bar.id,
        createdAt: '2025-11-02T06:15:00Z',
        dueAt: '2025-11-02T06:30:00Z',
        readyAt: '2025-11-02T06:20:00Z',
        status: ServeStatus.READY,
        quantity: 1,
      },
      {
        key: 'soonItem',
        stationId: bar.id,
        createdAt: new Date(now - 2 * 60_000).toISOString(),
        dueAt: new Date(now + 3 * 60_000).toISOString(),
        status: ServeStatus.PENDING,
        quantity: 2,
      },
    ];
    for (const ticket of tickets) {
      const item = await prisma.orderItem.create({
        data: {
          orderSessionId: session.id,
          menuItemId: menuItem.id,
          quantity: ticket.quantity,
          priceAtTime: 1,
          serveStatus: ticket.status,
          readyAt: ticket.readyAt ? new Date(ticket.readyAt) : null,
          createdAt: new Date(ticket.createdAt),
        },
      });
      if (ticket.key) ids[ticket.key] = item.id;
      await prisma.kitchenTicket.create({
        data: {
          stationId: ticket.stationId,
          orderSessionId: session.id,
          createdAt: new Date(ticket.createdAt),
          dueAt: new Date(ticket.dueAt),
          items: {
            create: {
              orderItemId: item.id,
              itemName: menuItem.name,
              quantity: ticket.quantity,
            },
          },
        },
      });
    }
  });

  afterAll(async () => {
    try {
      if (ids.session) {
        await prisma.kitchenTicketItem.deleteMany({
          where: { ticket: { orderSessionId: ids.session } },
        });
        await prisma.kitchenTicket.deleteMany({
          where: { orderSessionId: ids.session },
        });
        await prisma.orderItem.deleteMany({
          where: { orderSessionId: ids.session },
        });
        await prisma.orderSession.delete({ where: { id: ids.session } });
      }
      if (ids.menuItem)
        await prisma.menuItem.delete({ where: { id: ids.menuItem } });
      if (ids.bar)
        await prisma.kitchenStation.delete({ where: { id: ids.bar } });
      if (ids.food)
        await prisma.kitchenStation.delete({ where: { id: ids.food } });
      if (ids.category)
        await prisma.menuCategory.delete({ where: { id: ids.category } });
      if (ids.employee)
        await prisma.employee.delete({ where: { id: ids.employee } });
      if (ids.position)
        await prisma.position.delete({ where: { id: ids.position } });
    } finally {
      await prisma.$disconnect();
    }
  });

  it('groups by station and local hour, excluding cancelled tickets from completion', async () => {
    const report = await service.getKitchenBottlenecks({
      ...period,
      stationId: ids.bar,
    });
    expect(report.slots).toHaveLength(2);
    expect(report.slots[0]).toMatchObject({
      bucketStartAt: '2026-06-01T01:00:00.000Z',
      stationId: ids.bar,
      ticketCount: 4,
      orderedUnitCount: 7,
      completedCount: 2,
      lateCompletedCount: 1,
      openNowCount: 1,
      overdueOpenCount: 1,
      cancelledTicketCount: 1,
      lateRatePercent: '50.00',
      averageTicketToReadySeconds: 450,
      p95TicketToReadySeconds: 585,
    });
    expect(report.slots[1]).toMatchObject({
      bucketStartAt: '2026-06-01T02:00:00.000Z',
      stationId: ids.bar,
      ticketCount: 1,
      completedCount: 1,
      lateCompletedCount: 0,
    });
    const all = await service.getKitchenBottlenecks(period);
    expect(
      all.slots.filter((slot) => slot.stationId === ids.food),
    ).toHaveLength(1);
    const sla = await service.getKitchenSla({
      ...period,
      stationId: ids.bar,
    });
    expect(sla.stations).toEqual([
      expect.objectContaining({
        stationId: ids.bar,
        ticketCount: 5,
        completedCount: 3,
        lateCompletedCount: 1,
        overdueOpenCount: 1,
      }),
    ]);
  });

  it('uses local hour boundaries for a half-hour-offset time zone', async () => {
    const report = await service.getKitchenBottlenecks({
      ...period,
      timeZone: 'Asia/Kolkata',
      stationId: ids.bar,
    });
    expect(report.slots.map((slot) => slot.bucketStartAt)).toEqual([
      '2026-06-01T00:30:00.000Z',
      '2026-06-01T01:30:00.000Z',
    ]);
  });

  it('keeps repeated local hours separate during a daylight-saving fall-back', async () => {
    const report = await service.getKitchenBottlenecks({
      from: new Date('2025-11-02T05:00:00.000Z'),
      to: new Date('2025-11-02T07:00:00.000Z'),
      timeZone: 'America/New_York',
      stationId: ids.bar,
    });
    expect(report.slots.map((slot) => slot.bucketStartAt)).toEqual([
      '2025-11-02T05:00:00.000Z',
      '2025-11-02T06:00:00.000Z',
    ]);
  });

  it('shows current workload and removes tickets immediately when the item is ready', async () => {
    const snapshot = await kitchen.getWorkload();
    expect(snapshot.dueSoonWindowSeconds).toBe(300);
    expect(
      snapshot.stations.find((station) => station.stationId === ids.bar),
    ).toMatchObject({
      openTicketCount: 2,
      openUnitCount: 5,
      overdueTicketCount: 1,
      dueSoonTicketCount: 1,
    });
    expect(
      snapshot.stations.find((station) => station.stationId === ids.food),
    ).toMatchObject({
      openTicketCount: 0,
      openUnitCount: 0,
      overdueTicketCount: 0,
      dueSoonTicketCount: 0,
      nextDueAt: null,
    });

    await prisma.orderItem.update({
      where: { id: ids.soonItem },
      data: { serveStatus: ServeStatus.READY, readyAt: new Date() },
    });
    const refreshed = await kitchen.getWorkload();
    expect(
      refreshed.stations.find((station) => station.stationId === ids.bar),
    ).toMatchObject({
      openTicketCount: 1,
      openUnitCount: 3,
      overdueTicketCount: 1,
      dueSoonTicketCount: 0,
    });
  });
});
