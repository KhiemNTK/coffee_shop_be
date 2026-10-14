import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { assertDemoTarget, seedDemo } from './demo-data';

async function main() {
  const argument = (name: string) => {
    const index = process.argv.indexOf(name);
    return index >= 0 ? process.argv[index + 1] : undefined;
  };
  assertDemoTarget(
    process.env.NODE_ENV,
    process.env.DATABASE_URL ?? '',
    argument('--database'),
  );
  const prisma = new PrismaClient();
  try {
    console.log(
      'Demo data inserted:',
      await seedDemo(prisma, Number(argument('--seed') ?? 20261013)),
    );
  } finally {
    await prisma.$disconnect();
  }
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'Demo seed failed');
  process.exitCode = 1;
});
