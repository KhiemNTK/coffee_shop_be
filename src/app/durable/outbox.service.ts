import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import type {
  ExtendedPrismaTransactionClient,
  OutboxEventInput,
} from '../../common/types';
import { captureOutboxContext } from './outbox-context';

@Injectable()
export class OutboxService {
  enqueue(tx: ExtendedPrismaTransactionClient, input: OutboxEventInput) {
    const context = captureOutboxContext();
    return tx.outboxEvent.create({
      data: {
        ...input,
        payload: this.toJson(input.payload),
        ...(Object.keys(context).length
          ? { context: this.toJson(context) }
          : {}),
      },
      select: { id: true },
    });
  }

  private toJson(value: unknown): Prisma.InputJsonValue {
    return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
  }
}
