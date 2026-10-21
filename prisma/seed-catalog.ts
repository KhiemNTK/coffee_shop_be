import { config } from 'dotenv';
import { PrismaClient } from '@prisma/client';
import { assertCatalogTarget, seedCatalog } from './catalog-data';

if (process.env.NODE_ENV !== 'test') config({ quiet: true });

async function main() {
  const argument = (name: string) => {
    const index = process.argv.indexOf(name);
    return index >= 0 ? process.argv[index + 1] : undefined;
  };
  assertCatalogTarget(
    process.env.NODE_ENV,
    process.env.DATABASE_URL ?? '',
    argument('--database'),
  );
  const prisma = new PrismaClient();
  try {
    console.log(
      `Catalog inserted into ${argument('--database')}:`,
      await seedCatalog(
        prisma,
        Number(argument('--seed') ?? 20261017),
        process.argv.includes('--replace-demo'),
      ),
    );
  } finally {
    await prisma.$disconnect();
  }
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'Catalog seed failed');
  process.exitCode = 1;
});
