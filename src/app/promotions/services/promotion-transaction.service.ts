import { ConflictException, Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { ExtendedPrismaTransactionClient } from '../../../common/types';
import { PromotionsRepository } from '../repositories/promotions.repository';

@Injectable()
export class PromotionTransactionService {
  private readonly logger = new Logger(PromotionTransactionService.name);
  private readonly maxSerializableTransactionRetries = 3;
  private readonly serializableTransaction = {
    isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
  } as const;

  constructor(private readonly promotionsRepository: PromotionsRepository) {}

  async runSerializable<T>(
    callback: (tx: ExtendedPrismaTransactionClient) => Promise<T>,
  ): Promise<T> {
    for (
      let attempt = 1;
      attempt <= this.maxSerializableTransactionRetries;
      attempt++
    ) {
      try {
        return await this.promotionsRepository.client.$transaction(
          callback,
          this.serializableTransaction,
        );
      } catch (error) {
        if (
          this.isRetryableTransactionError(error) &&
          attempt < this.maxSerializableTransactionRetries
        ) {
          this.logger.warn(
            `Promotion transaction conflict. Retrying attempt ${attempt + 1}/${this.maxSerializableTransactionRetries}`,
          );
          await new Promise((resolve) => setTimeout(resolve, attempt * 25));
          continue;
        }

        throw error;
      }
    }

    throw new ConflictException('Transaction failed. Please try again.');
  }

  private isRetryableTransactionError(error: unknown) {
    return (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      (error.code === 'P2034' || error.code === 'P2002')
    );
  }
}
