import type { PrismaService } from '../prisma/prisma.service';

export type ExtendedPrismaClient = ReturnType<
  PrismaService['getExtendedClient']
>;

type ExtendedPrismaTransactionCallback = Parameters<
  ExtendedPrismaClient['$transaction']
>[0];

export type ExtendedPrismaTransactionClient =
  ExtendedPrismaTransactionCallback extends (tx: infer T) => Promise<unknown>
    ? T
    : never;
