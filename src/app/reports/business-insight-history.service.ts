import { ConflictException, Inject, Injectable } from '@nestjs/common';
import { Prisma, type BusinessInsight } from '@prisma/client';
import {
  PRISMA_SERVICE_TOKEN,
  type ExtendedPrismaClient,
} from '../../common/prisma/prisma.service';
import type {
  BusinessInsightJobData,
  BusinessInsightResult,
  BusinessInsightSnapshot,
} from '../../common/types';
import { OutboxService } from '../durable/outbox.service';
import {
  BUSINESS_INSIGHT_RETENTION_DAYS,
  BusinessInsightAnalysisSchema,
  BusinessInsightSnapshotSchema,
} from './business-insight.schema';
import type { GetBusinessInsightsDto } from './dto/business-insight.dto';

export const INSIGHT_REQUESTED = 'reports.insight.requested';

@Injectable()
export class BusinessInsightHistoryService {
  constructor(
    @Inject(PRISMA_SERVICE_TOKEN) private readonly prisma: ExtendedPrismaClient,
    private readonly outbox: OutboxService,
  ) {}

  find(employeeId: string, id: string) {
    return this.prisma.businessInsight.findFirst({ where: { id, employeeId } });
  }

  async record(
    id: string,
    data: BusinessInsightJobData,
    dispatch = true,
    completed?: BusinessInsightResult,
  ) {
    return this.prisma.$transaction(async (tx) => {
      const requestedAt = new Date(data.requestedAt);
      const inserted = await tx.businessInsight.createMany({
        data: {
          id,
          employeeId: data.employeeId,
          requestHash: data.requestHash,
          from: new Date(data.from),
          to: new Date(data.to),
          timeZone: data.timeZone,
          requestedAt,
          expiresAt: new Date(
            requestedAt.getTime() +
              BUSINESS_INSIGHT_RETENTION_DAYS * 86_400_000,
          ),
          model: data.model,
          promptVersion: data.promptVersion,
          ...(data.snapshot ? { snapshot: this.json(data.snapshot) } : {}),
          ...(completed
            ? {
                status: 'COMPLETED',
                snapshot: this.json(
                  BusinessInsightSnapshotSchema.parse(completed.snapshot),
                ),
                analysis: this.json(
                  BusinessInsightAnalysisSchema.parse(completed.analysis),
                ),
              }
            : {}),
        },
        skipDuplicates: true,
      });
      const row = await tx.businessInsight.findUniqueOrThrow({ where: { id } });
      if (row.employeeId !== data.employeeId)
        throw new ConflictException('Insight request identity mismatch.');
      this.checkRequest(row, data.requestHash);
      if (inserted.count && dispatch)
        await this.outbox.enqueue(tx, {
          topic: 'reports',
          eventName: INSIGHT_REQUESTED,
          aggregateType: 'BusinessInsight',
          aggregateId: id,
          payload: { id, employeeId: data.employeeId },
        });
      return row;
    });
  }

  checkRequest(this: void, row: BusinessInsight, requestHash: string) {
    if (row.expiresAt.getTime() <= Date.now())
      throw new ConflictException('Insight expired. Use a new request ID.');
    if (row.requestHash !== requestHash)
      throw new ConflictException(
        'The same request ID was used for a different period.',
      );
  }

  async list(employeeId: string, { cursor, limit }: GetBusinessInsightsDto) {
    const now = new Date();
    const anchor = cursor
      ? await this.prisma.businessInsight.findFirst({
          where: { id: cursor, employeeId, expiresAt: { gt: now } },
          select: { requestedAt: true, id: true },
        })
      : null;
    if (cursor && !anchor) return { items: [], nextCursor: null };
    const rows = await this.prisma.businessInsight.findMany({
      where: {
        employeeId,
        expiresAt: { gt: now },
        ...(anchor
          ? {
              OR: [
                { requestedAt: { lt: anchor.requestedAt } },
                { requestedAt: anchor.requestedAt, id: { lt: anchor.id } },
              ],
            }
          : {}),
      },
      orderBy: [{ requestedAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
      // Lists never load retained financial snapshots or narratives.
      select: {
        id: true,
        status: true,
        requestedAt: true,
        from: true,
        to: true,
        timeZone: true,
        expiresAt: true,
      },
    });
    return {
      items: rows.slice(0, limit).map((row) => ({
        id: row.id,
        status: row.status,
        requestedAt: row.requestedAt.toISOString(),
        expiresAt: row.expiresAt.toISOString(),
        period: {
          from: row.from.toISOString(),
          to: row.to.toISOString(),
          timeZone: row.timeZone,
        },
      })),
      nextCursor: rows.length > limit ? rows[limit - 1].id : null,
    };
  }

  jobData(this: void, row: BusinessInsight): BusinessInsightJobData {
    return {
      employeeId: row.employeeId,
      requestHash: row.requestHash,
      from: row.from.toISOString(),
      to: row.to.toISOString(),
      timeZone: row.timeZone,
      requestedAt: row.requestedAt.toISOString(),
      model: row.model,
      promptVersion: row.promptVersion,
      ...(row.snapshot
        ? { snapshot: BusinessInsightSnapshotSchema.parse(row.snapshot) }
        : {}),
    };
  }

  present(this: void, row: BusinessInsight) {
    return {
      id: row.id,
      status: row.status,
      requestedAt: row.requestedAt.toISOString(),
      model: row.model,
      promptVersion: row.promptVersion,
      period: {
        from: row.from.toISOString(),
        to: row.to.toISOString(),
        timeZone: row.timeZone,
      },
      snapshot: row.snapshot
        ? BusinessInsightSnapshotSchema.parse(row.snapshot)
        : null,
      analysis:
        row.status === 'COMPLETED'
          ? BusinessInsightAnalysisSchema.parse(row.analysis)
          : null,
      errorCode: row.errorCode,
    };
  }

  start(id: string, snapshot: BusinessInsightSnapshot) {
    return this.prisma.businessInsight.updateMany({
      where: { id, status: { in: ['QUEUED', 'PROCESSING'] } },
      data: {
        status: 'PROCESSING',
        snapshot: this.json(snapshot),
        errorCode: null,
      },
    });
  }

  beginProvider(id: string) {
    return this.prisma.businessInsight.updateMany({
      where: { id, status: 'PROCESSING', providerStartedAt: null },
      data: { providerStartedAt: new Date() },
    });
  }

  resetProvider(id: string) {
    return this.prisma.businessInsight.updateMany({
      where: { id, status: 'PROCESSING' },
      data: { providerStartedAt: null },
    });
  }

  complete(id: string, result: BusinessInsightResult) {
    return this.prisma.businessInsight.updateMany({
      where: { id, status: { in: ['QUEUED', 'PROCESSING'] } },
      data: {
        status: 'COMPLETED',
        snapshot: this.json(result.snapshot),
        analysis: this.json(result.analysis),
        errorCode: null,
      },
    });
  }

  fail(id: string, errorCode: string, terminal: boolean) {
    return this.prisma.businessInsight.updateMany({
      where: { id, status: { in: ['QUEUED', 'PROCESSING'] } },
      data: {
        status: terminal ? 'FAILED' : 'QUEUED',
        errorCode: terminal ? errorCode : null,
      },
    });
  }

  private json(value: unknown): Prisma.InputJsonValue {
    return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
  }
}
