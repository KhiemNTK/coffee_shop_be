import { RedisConnection } from 'bullmq';

export class InsightRedisConnection extends RedisConnection {
  override emit(event: string | symbol, ...args: unknown[]): boolean {
    // shortcut: BullMQ 5.78 can emit init errors after close; remove when upstream drains init before removing listeners.
    if (event === 'error' && this.status === 'closed') return false;
    return super.emit(event, ...args);
  }
}
