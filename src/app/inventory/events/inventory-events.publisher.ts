import { Injectable, Logger } from '@nestjs/common';
import type {
  InventoryEventListener,
  InventoryEventName,
  InventoryEventPayloadMap,
} from '../../../common/types';

@Injectable()
export class InventoryEventsPublisher {
  private readonly logger = new Logger(InventoryEventsPublisher.name);
  private readonly listeners = new Map<
    InventoryEventName,
    Set<InventoryEventListener<any>>
  >();

  emit<TEventName extends InventoryEventName>(
    eventName: TEventName,
    payload: InventoryEventPayloadMap[TEventName],
  ) {
    const listeners = this.listeners.get(eventName);
    if (!listeners?.size) return;

    for (const listener of listeners) {
      void Promise.resolve()
        .then(() => listener(payload))
        .catch((error: unknown) => {
          this.logger.error(
            `Inventory event listener failed for ${eventName}`,
            error instanceof Error ? error.stack : String(error),
          );
        });
    }
  }

  on<TEventName extends InventoryEventName>(
    eventName: TEventName,
    listener: InventoryEventListener<TEventName>,
  ) {
    const listeners = this.listeners.get(eventName) ?? new Set();
    listeners.add(listener);
    this.listeners.set(eventName, listeners);

    return () => {
      listeners.delete(listener);
    };
  }
}
