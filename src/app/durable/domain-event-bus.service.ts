import { Injectable } from '@nestjs/common';

export type DomainEventListener = (payload: unknown) => void | Promise<void>;

@Injectable()
export class DomainEventBusService {
  private readonly listeners = new Map<string, Set<DomainEventListener>>();

  on(eventName: string, listener: DomainEventListener) {
    const listeners = this.listeners.get(eventName) ?? new Set();
    listeners.add(listener);
    this.listeners.set(eventName, listeners);
    return () => listeners.delete(listener);
  }

  async publish(eventName: string, payload: unknown) {
    const listeners = [...(this.listeners.get(eventName) ?? [])];
    if (listeners.length === 0) return;

    const results = await Promise.allSettled(
      listeners.map((listener) =>
        Promise.resolve().then(() => listener(payload)),
      ),
    );
    const failure = results.find(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    );
    if (failure) {
      throw failure.reason;
    }
  }
}
