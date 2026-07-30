import type { PrismaService } from '../prisma/prisma.service';

export type ExtendedPrismaClient = ReturnType<
  PrismaService['getExtendedClient']
>;
