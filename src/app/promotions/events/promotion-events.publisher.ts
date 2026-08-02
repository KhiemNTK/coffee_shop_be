import { Injectable, Logger } from '@nestjs/common';
import type {
  PromotionEventListener,
  PromotionEventName,
  PromotionEventPayloadMap,
} from '../../../common/types';

@Injectable()
export class PromotionEventsPublisher {
  private readonly logger = new Logger(PromotionEventsPublisher.name);
  private readonly listeners = new Map<
    PromotionEventName,
    Set<PromotionEventListener<any>>
  >();

  emit<TEventName extends PromotionEventName>(
    eventName: TEventName,
    payload: PromotionEventPayloadMap[TEventName],
  ) {
    const listeners = this.listeners.get(eventName);
    if (!listeners?.size) return;

    for (const listener of listeners) {
      void Promise.resolve()
        .then(() => listener(payload))
        .catch((error: unknown) => {
          this.logger.error(
            `Promotion event listener failed for ${eventName}`,
            error instanceof Error ? error.stack : String(error),
          );
        });
    }
  }

  on<TEventName extends PromotionEventName>(
    eventName: TEventName,
    listener: PromotionEventListener<TEventName>,
  ) {
    const listeners = this.listeners.get(eventName) ?? new Set();
    listeners.add(listener);
    this.listeners.set(eventName, listeners);

    return () => {
      listeners.delete(listener);
    };
  }
}
