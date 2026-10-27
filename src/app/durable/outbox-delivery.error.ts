export class OutboxDeferredError extends Error {
  constructor(readonly retryAfterMs: number) {
    super('Delivery deferred by rate limit.');
  }
}

export class OutboxPermanentError extends Error {}

export function outboxFailureCode(error: unknown) {
  if (error instanceof OutboxPermanentError) return 'PERMANENT_REJECTION';
  if (error instanceof OutboxDeferredError) return 'RATE_LIMITED';
  return 'DELIVERY_FAILED';
}
