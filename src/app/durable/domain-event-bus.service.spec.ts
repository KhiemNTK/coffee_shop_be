import { DomainEventBusService } from './domain-event-bus.service';

describe('DomainEventBusService', () => {
  it('awaits listeners and surfaces delivery failures for retry', async () => {
    const service = new DomainEventBusService();
    const successful = jest.fn();
    service.on('order.invoice.paid', successful);
    service.on('order.invoice.paid', () => {
      throw new Error('delivery failed');
    });

    await expect(
      service.publish('order.invoice.paid', { invoiceId: 'invoice-id' }),
    ).rejects.toThrow('delivery failed');
    expect(successful).toHaveBeenCalledTimes(1);
  });
});
