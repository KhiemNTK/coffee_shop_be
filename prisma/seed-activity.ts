import { config } from 'dotenv';
import { PrismaClient } from '@prisma/client';
import { assertCatalogTarget } from './catalog-data';
import { ActivityOptionsSchema, seedActivity } from './activity-data';

if (process.env.NODE_ENV !== 'test') config({ quiet: true });

async function main() {
  const args = process.argv.slice(2);
  const known = new Set(['--database', '--seed', '--through', '--apply']);
  for (let i = 0; i < args.length; i++) {
    if (!known.has(args[i])) throw new Error(`Unknown argument: ${args[i]}`);
    if (args[i] !== '--apply' && (!args[++i] || args[i].startsWith('--')))
      throw new Error('Missing argument value.');
  }
  const value = (key: string) => args[args.indexOf(key) + 1];
  assertCatalogTarget(
    process.env.NODE_ENV,
    process.env.DATABASE_URL ?? '',
    args.includes('--database') ? value('--database') : undefined,
  );
  const options = ActivityOptionsSchema.parse({
    seed: Number(args.includes('--seed') ? value('--seed') : 20261022),
    through: args.includes('--through') ? value('--through') : undefined,
  });
  const prisma = new PrismaClient();
  try {
    console.log(
      JSON.stringify(
        await seedActivity(prisma, options, args.includes('--apply')),
        null,
        2,
      ),
    );
  } finally {
    await prisma.$disconnect();
  }
}

void main().catch((error: unknown) => {
  console.error(
    error instanceof Error ? error.message : 'Activity seed failed.',
  );
  process.exitCode = 1;
});
