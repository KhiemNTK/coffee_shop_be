import type { Prisma } from '@prisma/client';
import type { ExtendedPrismaTransactionClient } from './prisma.types';

export interface OutboxEventInput {
  topic: 'order' | 'inventory' | 'payment';
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
  payload: Prisma.JsonValue;
  attempts: number;
  occurredAt: Date;
}
