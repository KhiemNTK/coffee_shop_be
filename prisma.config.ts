import { config } from 'dotenv';
import { defineConfig, env } from 'prisma/config';
if (process.env.NODE_ENV !== 'test') config();
export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
    seed: 'ts-node prisma/seed.ts',
  },
  datasource: {
    url: env('DATABASE_URL'),
  },
});
