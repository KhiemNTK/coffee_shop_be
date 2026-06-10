import {
  Injectable,
  NotFoundException,
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

            const safeArgs = args as any;

            if (isSoftDeleteModel) {
              if (['findFirst', 'findMany', 'count'].includes(operation)) {
                safeArgs.where = { ...safeArgs.where, deletedAt: null };
                return query(safeArgs as typeof args);
              }

              if (
                operation === 'findUnique' ||
                operation === 'findUniqueOrThrow'
              ) {
                safeArgs.where = { ...safeArgs.where, deletedAt: null };

                const result = await (prismaClient as any)[model].findFirst(
                  safeArgs,
                );

                if (!result && operation === 'findUniqueOrThrow') {
                  throw new NotFoundException(`${model} not found.`);
                }
                return result;
              }

              if (operation === 'delete') {
                const record = await (prismaClient as any)[model].findFirst({
                  where: safeArgs.where,
                });
                if (!record) {
                  throw new NotFoundException(
                    `${model} not found for deletion.`,
                  );
                }
                return query(safeArgs as typeof args);
              }
            }

            return query(args);
          },
        },
      },
      model: {
        $allModels: {
          async softDelete<T>(
            this: T,
            where: Prisma.Args<T, 'updateMany'>['where'],
          ) {
            const context = Prisma.getExtensionContext(this);
            const modelName = (context as any).$name as string;

            if (!modelsWithSoftDelete.includes(modelName)) {
              throw new Error(
                `Model ${modelName} does not support soft delete`,
              );
            }

            return await (context as any).updateMany({
              data: { deletedAt: new Date() },
              where,
            });
          },
          async export<T>(
            this: T,
            args: Prisma.Args<T, 'findMany'> = {} as any,
          ) {
            const context = Prisma.getExtensionContext(this) as Record<
              string,
              any
            >;
            const FIELDS_EXCLUDE = ['id'];

            const modelFields = Object.keys(
              (context.fields as Record<string, unknown>) || {},
            );
            if (args.select) {
              const selectObj = args.select as Record<string, unknown>;
              const invalidFields = Object.keys(selectObj).filter(
                (field) => !modelFields.includes(field),
              );

              if (invalidFields.length > 0) {
                throw new BadRequestException(
                  `Invalid fields: ${invalidFields.join(', ')}`,
                );
              }
            } else {
              args.select ??= modelFields.reduce<Record<string, boolean>>(
                (acc, field) => {
                  if (!FIELDS_EXCLUDE.includes(field)) {
                    acc[field] = true;
                  }
                  return acc;
                },
                {},
              );
            }
            const result = await context.findMany(args);
            return result;
          },
        },
      },
    });
  }
}

export const PRISMA_SERVICE_TOKEN = 'PRISMA_SERVICE_TOKEN';
export type ExtendedPrismaClient = ReturnType<
  PrismaService['getExtendedClient']
>;
