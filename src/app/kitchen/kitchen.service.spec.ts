import { ServeStatus } from '@prisma/client';
import { PaginationUtilService } from '../../common/utils/pagination-util/pagination-util.service';
import { KitchenService } from './kitchen.service';

describe('KitchenService ticket state', () => {
  const prisma = {
    kitchenTicket: { findUnique: jest.fn() },
    kitchenStation: { count: jest.fn(), findMany: jest.fn() },
    $queryRaw: jest.fn(),
  };
  const service = new KitchenService(
    prisma as never,
    new PaginationUtilService(),
  );

  const ticket = (statuses: ServeStatus[]) => ({
    id: 'ticket-id',
    sequence: 42,
    station: { id: 'station-id', code: 'BAR', name: 'Bar' },
    orderSessionId: 'session-id',
    orderSession: { table: null },
    dueAt: new Date(Date.now() + 60_000),
    createdAt: new Date(),
    items: statuses.map((serveStatus, index) => ({
      id: `ticket-item-${index}`,
      orderItemId: `item-${index}`,
      itemName: 'Latte',
      quantity: 1,
      note: null,
      orderItem: { serveStatus, orderSession: { table: null } },
    })),
  });

  beforeEach(() => jest.clearAllMocks());

  it('uses the same active keyword scope for station count and paginated lookup', async () => {
    prisma.kitchenStation.count.mockResolvedValue(51);
    prisma.kitchenStation.findMany.mockResolvedValue([]);
    await expect(
      service.getStations({
        page: 3,
        itemPerPage: 20,
        isActive: true,
        keyword: 'BAR',
      }),
    ).resolves.toEqual({
      list: [],
      totalItems: 51,
      totalPages: 3,
      currentPage: 3,
    });
    expect(prisma.kitchenStation.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        skip: 40,
        take: 20,
        where: {
          deletedAt: null,
          isActive: true,
          OR: [
            { name: { contains: 'BAR', mode: 'insensitive' } },
            { code: { contains: 'BAR', mode: 'insensitive' } },
          ],
        },
      }),
    );
    expect(prisma.kitchenStation.count.mock.calls[0][0].where).toEqual(
      prisma.kitchenStation.findMany.mock.calls[0][0].where,
    );
  });

  it('completes the kitchen ticket when every item is READY or cancelled', async () => {
    prisma.kitchenTicket.findUnique.mockResolvedValue(
      ticket([ServeStatus.READY, ServeStatus.CANCELLED]),
    );

    await expect(service.getTicket('ticket-id')).resolves.toMatchObject({
      state: 'COMPLETED',
      isOverdue: false,
    });
  });

  it('keeps the ticket in progress while another item is pending', async () => {
    prisma.kitchenTicket.findUnique.mockResolvedValue(
      ticket([ServeStatus.READY, ServeStatus.PENDING]),
    );

    await expect(service.getTicket('ticket-id')).resolves.toMatchObject({
      state: 'IN_PROGRESS',
    });
  });

  it('returns one bounded workload snapshot with numeric counts', async () => {
    prisma.$queryRaw.mockResolvedValueOnce([
      {
        stationId: 'station-id',
        stationCode: 'BAR',
        stationName: 'Bar',
        isActive: true,
        openTicketCount: 2n,
        openUnitCount: 5n,
        overdueTicketCount: 1n,
        dueSoonTicketCount: 1n,
        oldestOpenAt: new Date('2026-01-01T00:00:00.000Z'),
        nextDueAt: new Date('2026-01-01T00:05:00.000Z'),
      },
    ]);
    const snapshot = await service.getWorkload();
    expect(snapshot).toMatchObject({
      dueSoonWindowSeconds: 300,
      stations: [
        {
          stationId: 'station-id',
          openTicketCount: 2,
          openUnitCount: 5,
          overdueTicketCount: 1,
          dueSoonTicketCount: 1,
        },
      ],
    });
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
  });
});
