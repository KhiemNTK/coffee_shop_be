import { Injectable, Logger } from '@nestjs/common';
import type {
  OrderEventListener,
  OrderEventName,
  OrderEventPayloadMap,
} from '../../../common/types';

@Injectable()
export class OrderEventsPublisher {
  private readonly logger = new Logger(OrderEventsPublisher.name);
  private readonly listeners = new Map<
    OrderEventName,
    Set<OrderEventListener<any>>
  >();

  emit<TEventName extends OrderEventName>(
    eventName: TEventName,
    payload: OrderEventPayloadMap[TEventName],
  ) {
    const listeners = this.listeners.get(eventName);
    if (!listeners?.size) return;

    for (const listener of listeners) {
      void Promise.resolve()
        .then(() => listener(payload))
        .catch((error: unknown) => {
          this.logger.error(
            `Order event listener failed for ${eventName}`,
            error instanceof Error ? error.stack : String(error),
          );
        });
    }
  }

  on<TEventName extends OrderEventName>(
    eventName: TEventName,
    listener: OrderEventListener<TEventName>,
  ) {
    const listeners = this.listeners.get(eventName) ?? new Set();
    listeners.add(listener);
    this.listeners.set(eventName, listeners);

    return () => {
      listeners.delete(listener);
    };
  }
}
