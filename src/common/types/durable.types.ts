import type { ExtendedPrismaTransactionClient } from './prisma.types';
import type { RequestContext } from './request-context.types';

export type OutboxDeliveryContext = Partial<
  Pick<RequestContext, 'requestId' | 'employeeId' | 'traceId'>
> & {
  traceparent?: string;
  tracestate?: string;
};

export interface OutboxEventInput {
  topic: 'order' | 'inventory' | 'payment' | 'auth' | 'reports';
  eventName: string;
  aggregateType: string;
  aggregateId: string;
  payload: unknown;
}

export interface IdempotentOperationInput {
  employeeId: string;
  operation: string;
  key: string;
  request: unknown;
}

export type IdempotentOperation<T> = (
  tx: ExtendedPrismaTransactionClient,
) => Promise<T>;

export interface ClaimedOutboxEvent {
  id: string;
  topic: string;
  eventName: string;
  aggregateType: string;
  aggregateId: string;
  payload: unknown;
  context?: unknown;
  attempts: number;
  lockedBy: string;
  occurredAt: Date;
}
