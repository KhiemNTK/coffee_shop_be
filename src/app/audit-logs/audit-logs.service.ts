import { Inject, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  PRISMA_SERVICE_TOKEN,
  type ExtendedPrismaClient,
} from '../../common/prisma/prisma.service';
import { PaginationUtilService } from '../../common/utils/pagination-util/pagination-util.service';
import { redactLogValue } from '../logger/log-redaction';
import { GetAuditLogsDto } from './dto/get-audit-logs.dto';

@Injectable()
export class AuditLogsService {
  constructor(
    @Inject(PRISMA_SERVICE_TOKEN)
    private readonly prisma: ExtendedPrismaClient,
    private readonly pagination: PaginationUtilService,
  ) {}

  async findAll(query: GetAuditLogsDto) {
    const where: Prisma.ActionLogWhereInput = {
      ...(query.employeeId ? { employeeId: query.employeeId } : {}),
      ...(query.actionType ? { actionType: query.actionType } : {}),
      ...(query.requestId ? { requestId: query.requestId } : {}),
      ...(query.from || query.to
        ? {
            createdAt: {
              ...(query.from ? { gte: query.from } : {}),
              ...(query.to ? { lte: query.to } : {}),
            },
          }
        : {}),
    };
    const totalItems = await this.prisma.actionLog.count({ where });
    const paging = this.pagination.paging({ ...query, totalItems });
    const list = await this.prisma.actionLog.findMany({
      where,
      skip: paging.skip,
      take: paging.itemPerPage,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      select: {
        id: true,
        actionType: true,
        createdAt: true,
        requestId: true,
        details: true,
        employee: { select: { id: true, fullName: true } },
      },
    });
    return paging.format(
      list.map((entry) => ({
        ...entry,
        details: redactLogValue(entry.details),
      })),
    );
  }
}
