import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import type {
  ExtendedPrismaTransactionClient,
  OutboxEventInput,
} from '../../common/types';

@Injectable()
export class OutboxService {
  enqueue(tx: ExtendedPrismaTransactionClient, input: OutboxEventInput) {
    return tx.outboxEvent.create({
      data: {
        ...input,
        payload: this.toJson(input.payload),
      },
      select: { id: true },
    });
  }

  private toJson(value: unknown): Prisma.InputJsonValue {
    return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
  }
}
