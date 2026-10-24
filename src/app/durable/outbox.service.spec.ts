import { OutboxService } from './outbox.service';
import { runWithRequestContext } from '../../common/request-context';
import { readOutboxContext } from './outbox-context';
import { propagation, trace } from '@opentelemetry/api';

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

  it('stores only correlation metadata, separately from the business payload', async () => {
    const create = jest.fn().mockResolvedValue({ id: 'event-id' });
    await runWithRequestContext(
      { requestId: 'request-12345678', employeeId: 'actor-id' },
      () =>
        new OutboxService().enqueue({ outboxEvent: { create } } as never, {
          topic: 'order',
          eventName: 'order.invoice.paid',
          aggregateType: 'Invoice',
          aggregateId: 'invoice-id',
          payload: { amount: '100000.00' },
        }),
    );
    expect(create.mock.calls[0][0].data).toMatchObject({
      context: { requestId: 'request-12345678', employeeId: 'actor-id' },
      payload: { amount: '100000.00' },
    });
    expect(
      readOutboxContext({
        requestId: 'request-12345678',
        password: 'never-persist',
        token: 'never-persist',
      }),
    ).toEqual({ requestId: 'request-12345678' });
  });

  it.each([
    null,
    undefined,
    { requestId: '\ninvalid' },
    { traceId: 'invalid' },
  ])('ignores invalid or legacy delivery metadata %p', (value) => {
    expect(readOutboxContext(value)).toEqual({});
  });

  it('captures only W3C trace carriers, not arbitrary baggage', async () => {
    const span = {
      traceId: 'a'.repeat(32),
      spanId: 'b'.repeat(16),
      traceFlags: 1,
    };
    const active = jest
      .spyOn(trace, 'getActiveSpan')
      .mockReturnValue({ spanContext: () => span } as never);
    const inject = jest
      .spyOn(propagation, 'inject')
      .mockImplementation((_context, carrier) => {
        Object.assign(carrier as object, {
          traceparent: `00-${span.traceId}-${span.spanId}-01`,
          baggage: 'customer-email=never-persist',
        });
      });
    try {
      const create = jest.fn().mockResolvedValue({ id: 'event-id' });
      await new OutboxService().enqueue({ outboxEvent: { create } } as never, {
        topic: 'order',
        eventName: 'order.invoice.paid',
        aggregateType: 'Invoice',
        aggregateId: 'invoice-id',
        payload: {},
      });
      expect(create.mock.calls[0][0].data.context).toEqual({
        traceId: span.traceId,
        traceparent: `00-${span.traceId}-${span.spanId}-01`,
      });
    } finally {
      active.mockRestore();
      inject.mockRestore();
    }
  });
});
