import { Injectable } from '@nestjs/common';
import type { ExtendedPrismaTransactionClient } from '../../../common/types';
import { PromotionsRepository } from '../repositories/promotions.repository';
import { runSerializableTransaction } from '../../../common/prisma/transaction.util';

@Injectable()
export class PromotionTransactionService {
  constructor(private readonly promotionsRepository: PromotionsRepository) {}

  runSerializable<T>(
    callback: (tx: ExtendedPrismaTransactionClient) => Promise<T>,
  ): Promise<T> {
    return runSerializableTransaction(
      this.promotionsRepository.client,
      callback,
      {
        loggerContext: 'Promotion transaction',
        retryUniqueViolations: true,
      },
    );
  }
}
