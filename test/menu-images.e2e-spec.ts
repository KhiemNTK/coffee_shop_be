import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import { Logger } from '@nestjs/common';
import { MenuImageStatus, PrismaClient } from '@prisma/client';
import { MenuImagesService } from '../src/app/menu/menu-images.service';
import { MenuService } from '../src/app/menu/menu.service';
import {
  PrismaService,
  type ExtendedPrismaClient,
} from '../src/common/prisma/prisma.service';
import { PaginationUtilService } from '../src/common/utils/pagination-util/pagination-util.service';

describe('Menu images (isolated PostgreSQL)', () => {
  const databaseName = `menu_images_${randomUUID().replaceAll('-', '')}_test`;
  const originalUrl = process.env.DATABASE_URL;
  let created = false;
  let admin: PrismaClient | undefined;
  let base: PrismaService | undefined;
  let prisma: ExtendedPrismaClient;
  let images: MenuImagesService;
  let menu: MenuService;
  let employeeId: string;
  let categoryId: string;

  beforeAll(async () => {
    const target = new URL(originalUrl ?? '');
    assert(
      process.env.NODE_ENV === 'test' &&
        ['localhost', '127.0.0.1'].includes(target.hostname) &&
        target.pathname.endsWith('_test'),
      'Only use a dedicated loopback test database.',
    );
    admin = new PrismaClient({ datasources: { db: { url: target.href } } });
    await admin.$executeRawUnsafe(`CREATE DATABASE "${databaseName}"`);
    created = true;
    target.pathname = `/${databaseName}`;
    process.env.DATABASE_URL = target.href;
    execFileSync(
      process.execPath,
      [require.resolve('prisma/build/index.js'), 'migrate', 'deploy'],
      { env: process.env, stdio: 'pipe' },
    );
    base = new PrismaService();
    await base.$connect();
    prisma = base.getExtendedClient();
    images = new MenuImagesService(prisma, new ConfigService());
    menu = new MenuService(prisma, new PaginationUtilService(), images);
    const position = await prisma.position.create({
      data: { name: 'Image test', salary: 0 },
    });
    const employee = await prisma.employee.create({
      data: {
        email: 'images@test.example',
        username: 'images-test',
        fullName: 'Image test',
        password: 'fixture-only',
        positionId: position.id,
      },
    });
    employeeId = employee.id;
    categoryId = (
      await prisma.menuCategory.create({ data: { name: 'Image test' } })
    ).id;
    jest.spyOn(Logger, 'warn').mockImplementation();
  }, 60_000);
  afterAll(async () => {
    jest.restoreAllMocks();
    if (originalUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = originalUrl;
    await base?.$disconnect();
    try {
      if (created && admin)
        await admin.$executeRawUnsafe(
          `DROP DATABASE "${databaseName}" WITH (FORCE)`,
        );
    } finally {
      await admin?.$disconnect();
    }
  });

  async function draft(expiresAt = new Date(Date.now() + 60_000)) {
    const id = randomUUID();
    return prisma.menuImageUpload.create({
      data: {
        id,
        employeeId,
        objectKey: `managed-menu/${id}.webp`,
        url: `https://images.test/${id}.webp`,
        status: MenuImageStatus.READY,
        expiresAt,
      },
    });
  }
  const itemInput = (name: string, imageUrl: string) => ({
    name,
    imageUrl,
    price: '35000',
    categoryId,
  });

  it('allows only one of two concurrent menu creations to claim the same image', async () => {
    const image = await draft();
    const results = await Promise.allSettled([
      menu.createItem(employeeId, itemInput('Race A', image.url)),
      menu.createItem(employeeId, itemInput('Race B', image.url)),
    ]);
    expect(
      results.filter((result) => result.status === 'fulfilled'),
    ).toHaveLength(1);
    expect(
      results.filter((result) => result.status === 'rejected'),
    ).toHaveLength(1);
    expect(
      await prisma.menuItem.count({ where: { imageUrl: image.url } }),
    ).toBe(1);
    expect(
      await prisma.menuImageUpload.findUnique({ where: { id: image.id } }),
    ).toMatchObject({ status: MenuImageStatus.ATTACHED, expiresAt: null });
  });

  it('rolls back attachment with the business transaction and rejects expired drafts', async () => {
    const image = await draft();
    const item = await menu.createItem(employeeId, {
      name: 'Rollback',
      price: '35000',
      categoryId,
    });
    await expect(
      prisma.$transaction(async (tx) => {
        await images.syncReference(tx, employeeId, item.id, image.url);
        throw new Error('rollback');
      }),
    ).rejects.toThrow('rollback');
    expect(
      await prisma.menuImageUpload.findUnique({ where: { id: image.id } }),
    ).toMatchObject({ status: MenuImageStatus.READY, menuItemId: null });
    const expired = await draft(new Date(Date.now() - 1000));
    await expect(
      menu.updateItem(item.id, employeeId, { imageUrl: expired.url }),
    ).rejects.toMatchObject({
      response: { code: 'IMAGE_UPLOAD_NOT_AVAILABLE' },
    });
    expect(
      (await prisma.menuItem.findUniqueOrThrow({ where: { id: item.id } }))
        .imageUrl,
    ).toBeNull();
  });

  it('queues replaced/deleted images with a grace period without any remote call', async () => {
    const first = await draft();
    const second = await draft();
    const item = await menu.createItem(
      employeeId,
      itemInput('Replace', first.url),
    );
    await menu.updateItem(item.id, employeeId, { imageUrl: second.url });
    expect(
      await prisma.menuImageUpload.findUnique({ where: { id: first.id } }),
    ).toMatchObject({
      status: MenuImageStatus.DELETING,
      expiresAt: expect.any(Date),
    });
    await menu.deleteItem(item.id, employeeId);
    expect(
      await prisma.menuImageUpload.findUnique({ where: { id: second.id } }),
    ).toMatchObject({
      status: MenuImageStatus.DELETING,
      expiresAt: expect.any(Date),
    });
  });

  it('an expired draft cannot be attached after cleanup claims it', async () => {
    const image = await draft(new Date(Date.now() - 1000));
    const claimed = await prisma.menuImageUpload.updateMany({
      where: {
        id: image.id,
        status: MenuImageStatus.READY,
        expiresAt: { lte: new Date() },
      },
      data: {
        status: MenuImageStatus.DELETING,
        expiresAt: new Date(Date.now() + 300_000),
      },
    });
    expect(claimed.count).toBe(1);
    await expect(
      menu.createItem(employeeId, itemInput('Too late', image.url)),
    ).rejects.toMatchObject({
      response: { code: 'IMAGE_UPLOAD_NOT_AVAILABLE' },
    });
    expect(
      await prisma.menuItem.count({ where: { imageUrl: image.url } }),
    ).toBe(0);
  });

  it('database constraints reject an attached image without an item or expiry on a draft', async () => {
    const image = await draft();
    await expect(
      prisma.menuImageUpload.update({
        where: { id: image.id },
        data: { status: MenuImageStatus.ATTACHED, expiresAt: null },
      }),
    ).rejects.toThrow();
    await expect(
      prisma.menuImageUpload.update({
        where: { id: image.id },
        data: { expiresAt: null },
      }),
    ).rejects.toThrow();
  });
});
