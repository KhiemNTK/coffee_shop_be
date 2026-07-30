import {
  Injectable,
  OnModuleDestroy,
  OnModuleInit,
  BadRequestException,
} from '@nestjs/common';
import { PrismaClient, Prisma } from '@prisma/client';

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

    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const prismaClient = this;

    return prismaClient.$extends({
      query: {
        $allModels: {
          async $allOperations({ model, operation, args, query }) {
            const isSoftDeleteModel = modelsWithSoftDelete.includes(model);
            if (!isSoftDeleteModel) return query(args);

            const safeArgs = (args ? { ...args } : {}) as Record<string, any>;

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
              if (safeArgs.where.deletedAt === undefined) {
                safeArgs.where.deletedAt = null;
              }
              return query(safeArgs as typeof args);
            }

            if (
              operation === 'findUnique' ||
              operation === 'findUniqueOrThrow'
            ) {
              safeArgs.where = safeArgs.where || {};
              if (safeArgs.where.deletedAt === undefined) {
                safeArgs.where.deletedAt = null;
              }

              const targetOperation =
                operation === 'findUnique' ? 'findFirst' : 'findFirstOrThrow';

              const result = await (prismaClient as any)[model][
                targetOperation
              ](safeArgs);
              return result;
            }

            if (operation === 'delete') {
              safeArgs.data = { deletedAt: new Date() };
              return (prismaClient as any)[model].update(safeArgs);
            }

            if (operation === 'deleteMany') {
              safeArgs.data = { deletedAt: new Date() };
              return (prismaClient as any)[model].updateMany(safeArgs);
            }

            return query(args);
          },
        },
      },
      model: {
        $allModels: {
          async export<T>(
            this: T,
            args: Prisma.Args<T, 'findMany'> = {} as any,
          ) {
            const context = Prisma.getExtensionContext(this);
            const modelName = (context as any).$name as string;

            const modelDefinition = Prisma.dmmf.datamodel.models.find(
              (m) => m.name === modelName,
            );
            if (!modelDefinition) {
              throw new BadRequestException(
                `Model ${modelName} not found in DMMF`,
              );
            }

            const modelFields = modelDefinition.fields.map((f) => f.name);
            const FIELDS_EXCLUDE = ['id', 'password', 'deletedAt'];

            if (args.select) {
              const selectObj = args.select as Record<string, unknown>;
              const invalidFields = Object.keys(selectObj).filter(
                (field) => !modelFields.includes(field),
              );

              if (invalidFields.length > 0) {
                throw new BadRequestException(
                  `Invalid fields for export: ${invalidFields.join(', ')}`,
                );
              }
            } else {
              (args as Record<string, any>).select = modelFields.reduce<
                Record<string, boolean>
              >((acc, field) => {
                if (!FIELDS_EXCLUDE.includes(field)) {
                  acc[field] = true;
                }
                return acc;
              }, {});
            }

            return await (context as any).findMany(args);
          },
        },
      },
    });
  }
}

export const PRISMA_SERVICE_TOKEN = 'PRISMA_SERVICE_TOKEN';
export type { ExtendedPrismaClient } from '../types/prisma.types';
