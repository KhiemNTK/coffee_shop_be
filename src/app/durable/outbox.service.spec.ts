import { OutboxService } from './outbox.service';

describe('OutboxService', () => {
  it('serializes a domain event into the current transaction', async () => {
    const tx = {
      outboxEvent: { create: jest.fn().mockResolvedValue({ id: 'event-id' }) },
    };
    const service = new OutboxService();

    await service.enqueue(tx as never, {
      topic: 'order',
      eventName: 'order.invoice.paid',
      aggregateType: 'Invoice',
      aggregateId: 'invoice-id',
      payload: { amount: '100000.00' },
    });

    expect(tx.outboxEvent.create).toHaveBeenCalledWith({
      data: {
        topic: 'order',
        eventName: 'order.invoice.paid',
        aggregateType: 'Invoice',
        aggregateId: 'invoice-id',
        payload: { amount: '100000.00' },
      },
      select: { id: true },
    });
  });
});
