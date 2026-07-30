import { ConflictException, Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { InventoryRepository } from '../repositories/inventory.repository';

@Injectable()
export class InventoryTransactionService {
  private readonly logger = new Logger(InventoryTransactionService.name);
  private readonly maxSerializableTransactionRetries = 3;
  private readonly serializableTransaction = {
    isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
  } as const;

  constructor(private readonly inventoryRepository: InventoryRepository) {}

  async runSerializable<T>(callback: (tx: any) => Promise<T>): Promise<T> {
    for (
      let attempt = 1;
      attempt <= this.maxSerializableTransactionRetries;
      attempt++
    ) {
      try {
        return (await (this.inventoryRepository.client.$transaction as any)(
          callback,
          this.serializableTransaction,
        )) as T;
      } catch (error) {
        if (
          this.isRetryableTransactionError(error) &&
          attempt < this.maxSerializableTransactionRetries
        ) {
          this.logger.warn(
            `Inventory transaction conflict. Retrying attempt ${attempt + 1}/${this.maxSerializableTransactionRetries}`,
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
