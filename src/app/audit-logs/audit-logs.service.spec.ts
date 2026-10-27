import type { ExtendedPrismaClient } from '../../common/prisma/prisma.service';
import { PaginationUtilService } from '../../common/utils/pagination-util/pagination-util.service';
import { AuditLogsService } from './audit-logs.service';
import { GetAuditLogsDto } from './dto/get-audit-logs.dto';

describe('AuditLogsService', () => {
  it('paginates newest first and redacts credentials from details', async () => {
    const prisma = {
      actionLog: {
        count: jest.fn().mockResolvedValue(1),
        findMany: jest.fn().mockResolvedValue([
          {
            id: 'log-id',
            actionType: 'PAYMENT_REFUND_REQUESTED',
            createdAt: new Date('2026-09-25T10:00:00.000Z'),
            requestId: 'request-id',
            employee: { id: 'employee-id', fullName: 'Manager' },
            details: { token: 'secret-value', invoiceId: 'invoice-id' },
          },
        ]),
      },
    };
    const service = new AuditLogsService(
      prisma as unknown as ExtendedPrismaClient,
      new PaginationUtilService(),
    );

    const result = await service.findAll({
      page: 1,
      itemPerPage: 20,
      actionPrefix: 'PAYMENT',
      keyword: 'request-id',
    });

    expect(prisma.actionLog.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        take: 20,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        where: {
          AND: [{ actionType: { startsWith: 'PAYMENT_' } }],
          OR: [
            { actionType: { contains: 'request-id', mode: 'insensitive' } },
            { requestId: 'request-id' },
          ],
        },
      }),
    );
    expect(result.list[0].details).toEqual({
      token: '[REDACTED]',
      invoiceId: 'invoice-id',
    });
  });

  it('validates audit filters and keeps exact action and request filters available', () => {
    expect(
      GetAuditLogsDto.schema.safeParse({ actionPrefix: 'PAYMENT_%' }).success,
    ).toBe(false);
    expect(
      GetAuditLogsDto.schema.parse({
        actionType: 'PAYMENT_REFUND_REQUESTED',
        requestId: 'request-id',
      }),
    ).toMatchObject({
      actionType: 'PAYMENT_REFUND_REQUESTED',
      requestId: 'request-id',
    });
  });
});
