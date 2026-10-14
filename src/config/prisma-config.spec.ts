import { createRequire } from 'node:module';
import { defineConfig } from 'prisma/config';

describe('Prisma CLI security override', () => {
  it('preserves the project schema and migration configuration', () => {
    const config = defineConfig({
      schema: 'prisma/schema.prisma',
      migrations: { path: 'prisma/migrations', seed: 'ts-node prisma/seed.ts' },
    });
    expect(config).toMatchObject({
      schema: 'prisma/schema.prisma',
      migrations: { path: 'prisma/migrations', seed: 'ts-node prisma/seed.ts' },
    });
  });

  it('uses the patched merger without stack exhaustion on recursive objects', () => {
    const fromPrisma = createRequire(
      createRequire(__filename).resolve('prisma/config'),
    );
    const fromConfig = createRequire(fromPrisma.resolve('@prisma/config'));
    const { deepmerge } = fromConfig('deepmerge-ts') as {
      deepmerge(this: void, ...objects: object[]): unknown;
    };
    const left: { self?: object } = {};
    const right: { self?: object } = {};
    left.self = left;
    right.self = right;
    expect(() => deepmerge(left, right)).not.toThrow(RangeError);
  });
});
