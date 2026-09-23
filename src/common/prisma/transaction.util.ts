import { ConflictException, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type {
  ExtendedPrismaClient,
  ExtendedPrismaTransactionClient,
} from '../types';
import { transactionRetriesTotal } from '../observability/metrics';

export interface TransactionRetryOptions {
  maxRetries?: number;
  delayMs?: number;
  loggerContext?: string;
  isolationLevel?: Prisma.TransactionIsolationLevel;
  retryUniqueViolations?: boolean;
}

const isRetryableError = (
  error: unknown,
  retryUniqueViolations: boolean,
): boolean => {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    (error.code === 'P2034' ||
      (retryUniqueViolations && error.code === 'P2002'))
  );
};

export async function runSerializableTransaction<T>(
  prisma: ExtendedPrismaClient,
  callback: (tx: ExtendedPrismaTransactionClient) => Promise<T>,
  options?: TransactionRetryOptions,
): Promise<T> {
  const maxRetries = options?.maxRetries ?? 3;
  const baseDelayMs = options?.delayMs ?? 25;
  const loggerContext = options?.loggerContext ?? 'Transaction';
  const isolationLevel =
    options?.isolationLevel ?? Prisma.TransactionIsolationLevel.Serializable;
  const retryUniqueViolations = options?.retryUniqueViolations ?? false;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await prisma.$transaction(callback, { isolationLevel });
    } catch (error) {
      if (
        isRetryableError(error, retryUniqueViolations) &&
        attempt < maxRetries
      ) {
        transactionRetriesTotal.inc({
          context: loggerContext,
          error_code: error.code,
        });
        Logger.warn(
          `${loggerContext} conflict. Retrying attempt ${attempt + 1}/${maxRetries}`,
          loggerContext,
        );
        await new Promise((resolve) =>
          setTimeout(resolve, attempt * baseDelayMs),
        );
        continue;
      }
      throw error;
    }
  }

  throw new ConflictException('Transaction failed. Please try again.');
}
