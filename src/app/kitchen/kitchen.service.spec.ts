import { ServeStatus } from '@prisma/client';
import { PaginationUtilService } from '../../common/utils/pagination-util/pagination-util.service';
import { KitchenService } from './kitchen.service';

describe('KitchenService ticket state', () => {
  const prisma = { kitchenTicket: { findUnique: jest.fn() } };
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
});
