export class OutboxDeferredError extends Error {
  constructor(readonly retryAfterMs: number) {
    super('Delivery deferred by rate limit.');
  }
}

export class OutboxPermanentError extends Error {}
