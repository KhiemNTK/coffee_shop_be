import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaClient, Prisma } from '@prisma/client';
import { getRequestContext } from '../request-context';

@Injectable()
export class PrismaService
  extends PrismaClient
  implements OnModuleInit, OnModuleDestroy
{
  constructor() {
    super({
      transactionOptions: {
        maxWait: 5000,
        timeout: 10000,
      },
    });
  }

  async onModuleInit() {
    await this.$connect();
  }

  async onModuleDestroy() {
    await this.$disconnect();
  }

  getExtendedClient() {
    const modelsWithSoftDelete = Prisma.dmmf.datamodel.models
      .filter((model) => model.fields.some((f) => f.name === 'deletedAt'))
      .map((model) => model.name);

    return this.$extends({
      query: {
        $allModels: {
          async $allOperations({ model, operation, args, query }) {
            if (model === 'ActionLog' && operation === 'create') {
              const safeArgs = { ...(args as object) } as Record<string, any>;
              const data = { ...(safeArgs.data as Record<string, unknown>) };
              data.requestId ??= getRequestContext()?.requestId;
              safeArgs.data = data;
              return query(safeArgs as typeof args);
            }

            const isSoftDeleteModel = modelsWithSoftDelete.includes(model);
            if (!isSoftDeleteModel) return query(args);

            const safeArgs: Record<string, any> = Object.assign({}, args);

            if (
              [
                'findMany',
                'findFirst',
                'findFirstOrThrow',
                'count',
                'aggregate',
                'groupBy',
              ].includes(operation)
            ) {
              safeArgs.where = safeArgs.where || {};
              const includeDeleted = safeArgs.where.__includeDeleted === true;
              delete safeArgs.where.__includeDeleted;

              if (!includeDeleted && safeArgs.where.deletedAt === undefined) {
                safeArgs.where.deletedAt = null;
              }
              return query(safeArgs as typeof args);
            }

            if (
              operation === 'findUnique' ||
              operation === 'findUniqueOrThrow'
            ) {
              safeArgs.where = safeArgs.where || {};
              const includeDeleted = safeArgs.where.__includeDeleted === true;
              delete safeArgs.where.__includeDeleted;

              if (!includeDeleted && safeArgs.where.deletedAt === undefined) {
                safeArgs.where.deletedAt = null;
              }

              // Prisma 6 supports non-unique filters; keep the transaction-bound query.
              return query(safeArgs as typeof args);
            }

            if (operation === 'delete' || operation === 'deleteMany') {
              // Re-routing through the base client would escape interactive transactions.
              throw new Error(
                `${model}: use update/updateMany with deletedAt for soft deletion.`,
              );
            }

            return query(args);
          },
        },
      },
    });
  }
}

export const PRISMA_SERVICE_TOKEN = 'PRISMA_SERVICE_TOKEN';
export type { ExtendedPrismaClient } from '../types/prisma.types';
