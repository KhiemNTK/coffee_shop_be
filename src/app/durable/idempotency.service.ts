import { createHash } from 'node:crypto';
import { ConflictException, Inject, Injectable, Logger } from '@nestjs/common';
import { IdempotencyRequestStatus, Prisma } from '@prisma/client';
import {
  PRISMA_SERVICE_TOKEN,
  type ExtendedPrismaClient,
} from '../../common/prisma/prisma.service';
import type {
  ExtendedPrismaTransactionClient,
  IdempotentOperation,
  IdempotentOperationInput,
} from '../../common/types';

const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;

@Injectable()
export class IdempotencyService {
  private readonly logger = new Logger(IdempotencyService.name);

  constructor(
    @Inject(PRISMA_SERVICE_TOKEN)
    private readonly prisma: ExtendedPrismaClient,
  ) {}

  async execute<T>(
    input: IdempotentOperationInput,
    operation: IdempotentOperation<T>,
  ): Promise<T> {
    const requestHash = this.hash(input.request);
    const existing = await this.findExisting(input);
    if (existing) return this.replay<T>(existing, requestHash);

    try {
      return await this.runSerializable(async (tx) => {
        const replay = await tx.idempotencyRequest.findUnique({
          where: {
            employeeId_operation_key: {
              employeeId: input.employeeId,
              operation: input.operation,
              key: input.key,
            },
          },
        });
        if (replay) return this.replay<T>(replay, requestHash);

        const request = await tx.idempotencyRequest.create({
          data: {
            employeeId: input.employeeId,
            operation: input.operation,
            key: input.key,
            requestHash,
            expiresAt: new Date(Date.now() + IDEMPOTENCY_TTL_MS),
          },
          select: { id: true },
        });
        const result = await operation(tx);
        await tx.idempotencyRequest.update({
          where: { id: request.id },
          data: {
            status: IdempotencyRequestStatus.COMPLETED,
            response: this.toJson(result),
            completedAt: new Date(),
          },
        });
        return result;
      });
    } catch (error) {
      if (!this.isIdempotencyCollision(error)) throw error;
      const replay = await this.findExisting(input);
      if (!replay) throw error;
      return this.replay<T>(replay, requestHash);
    }
  }

  private findExisting(input: IdempotentOperationInput) {
    return this.prisma.idempotencyRequest.findUnique({
      where: {
        employeeId_operation_key: {
          employeeId: input.employeeId,
          operation: input.operation,
          key: input.key,
        },
      },
    });
  }

  private replay<T>(
    request: {
      requestHash: string;
      status: IdempotencyRequestStatus;
      response: unknown;
    },
    requestHash: string,
  ): T {
    if (request.requestHash !== requestHash) {
      throw new ConflictException(
        'Idempotency key was already used with a different request.',
      );
    }
    if (
      request.status !== IdempotencyRequestStatus.COMPLETED ||
      request.response === null
    ) {
      throw new ConflictException('The idempotent operation is still running.');
    }
    return request.response as T;
  }

  private hash(value: unknown) {
    return createHash('sha256').update(JSON.stringify(value)).digest('hex');
  }

  private toJson(value: unknown): Prisma.InputJsonValue {
    return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
  }

  private isIdempotencyCollision(error: unknown) {
    if (
      !(error instanceof Prisma.PrismaClientKnownRequestError) ||
      error.code !== 'P2002'
    ) {
      return false;
    }
    const target = error.meta?.target;
    return (
      (Array.isArray(target) &&
        target.includes('employeeId') &&
        target.includes('operation') &&
        target.includes('key')) ||
      target === 'IdempotencyRequest_employeeId_operation_key_key'
    );
  }

  private async runSerializable<T>(
    callback: (tx: ExtendedPrismaTransactionClient) => Promise<T>,
  ): Promise<T> {
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        return await this.prisma.$transaction(callback, {
          isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
        });
      } catch (error) {
        const retryable =
          error instanceof Prisma.PrismaClientKnownRequestError &&
          error.code === 'P2034';
        if (!retryable || attempt === 3) throw error;
        this.logger.warn(
          `Idempotent transaction conflict. Retrying ${attempt + 1}/3`,
        );
        await new Promise((resolve) => setTimeout(resolve, attempt * 25));
      }
    }
    throw new ConflictException('Transaction failed. Please try again.');
  }
}
