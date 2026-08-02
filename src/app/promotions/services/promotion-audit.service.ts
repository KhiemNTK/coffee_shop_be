import { Injectable } from '@nestjs/common';

@Injectable()
export class PromotionAuditService {
  async log(
    tx: any,
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
        details,
      },
    });
  }
}
