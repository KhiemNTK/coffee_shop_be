import { Prisma } from '@prisma/client';
import { KitchenRoutingService } from './kitchen-routing.service';
import { PrintingService } from '../printing/printing.service';

describe('KitchenRoutingService', () => {
  it('creates one ticket per station and only enqueues configured printers', async () => {
    const printing = {
      enqueueKitchenTicket: jest.fn().mockResolvedValue({ id: 'print-job' }),
    };
    const service = new KitchenRoutingService(
      printing as unknown as PrintingService,
    );
    let sequence = 0;
    const tx = {
      orderSession: {
        findUniqueOrThrow: jest.fn().mockResolvedValue({
          table: { name: 'T01' },
        }),
      },
      kitchenTicket: {
        create: jest.fn().mockImplementation(({ data }) => ({
          id: `ticket-${++sequence}`,
          sequence,
          dueAt: data.dueAt,
          items: data.items.create.map((item: object, index: number) => ({
            id: `ticket-item-${sequence}-${index}`,
            ...item,
          })),
        })),
      },
    };

    const tickets = await service.createTickets(tx as never, {
      orderSessionId: 'session-id',
      menuItems: [
        {
          id: 'coffee',
          name: 'Coffee',
          price: new Prisma.Decimal(30_000),
          kitchenStation: {
            id: 'bar',
            code: 'BAR',
            name: 'Bar',
            prepSlaSeconds: 300,
            printDevice: {
              id: 'kitchen-printer',
              isActive: true,
              deletedAt: null,
            },
          },
        },
        {
          id: 'cake',
          name: 'Cake',
          price: new Prisma.Decimal(40_000),
          kitchenStation: {
            id: 'bakery',
            code: 'BAKERY',
            name: 'Bakery',
            prepSlaSeconds: 600,
            printDevice: null,
          },
        },
        {
          id: 'bottle',
          name: 'Water',
          price: new Prisma.Decimal(10_000),
          kitchenStation: null,
        },
      ],
      orderItems: [
        {
          id: 'order-coffee',
          menuItemId: 'coffee',
          quantity: 2,
          note: null,
        },
        {
          id: 'order-cake',
          menuItemId: 'cake',
          quantity: 1,
          note: 'Warm',
        },
        {
          id: 'order-water',
          menuItemId: 'bottle',
          quantity: 1,
          note: null,
        },
      ],
    });

    expect(tickets).toHaveLength(2);
    expect(tx.kitchenTicket.create).toHaveBeenCalledTimes(2);
    expect(printing.enqueueKitchenTicket).toHaveBeenCalledTimes(1);
    expect(printing.enqueueKitchenTicket).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({
        kitchenTicketId: 'ticket-1',
        deviceId: 'kitchen-printer',
      }),
    );
  });
});
