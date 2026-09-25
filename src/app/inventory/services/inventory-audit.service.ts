import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import type { ExtendedPrismaTransactionClient } from '../../../common/types';

@Injectable()
export class InventoryAuditService {
  async log(
    tx: ExtendedPrismaTransactionClient,
    {
      employeeId,
      actionType,
      details,
    }: {
      employeeId: string;
      actionType: string;
      details: Record<string, unknown>;
    },
  ) {
    await tx.actionLog.create({
      data: {
        employeeId,
        actionType,
        details: JSON.parse(JSON.stringify(details)) as Prisma.InputJsonValue,
      },
    });
  }
}
