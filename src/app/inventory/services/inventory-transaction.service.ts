import { Injectable } from '@nestjs/common';
import type { ExtendedPrismaTransactionClient } from '../../../common/types';
import { InventoryRepository } from '../repositories/inventory.repository';
import { runSerializableTransaction } from '../../../common/prisma/transaction.util';

@Injectable()
export class InventoryTransactionService {
  constructor(private readonly inventoryRepository: InventoryRepository) {}

  runSerializable<T>(
    callback: (tx: ExtendedPrismaTransactionClient) => Promise<T>,
  ): Promise<T> {
    return runSerializableTransaction(
      this.inventoryRepository.client,
      callback,
      {
        loggerContext: 'Inventory transaction',
        retryUniqueViolations: true,
      },
    );
  }
}
