import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MenuImageStatus } from '@prisma/client';
import { StorageClient } from '@supabase/storage-js';
import sharp from 'sharp';
import { MENU_IMAGE_MAX_BYTES } from '../../common/consts/menu-images';
import { MenuImagesService } from './menu-images.service';

const origin = 'https://images.example.test';
const urlFor = (key: string) =>
  `${origin}/storage/v1/object/public/menu-images/${key}`;
const file = (buffer: Buffer, mimetype = 'image/png') =>
  ({ buffer, mimetype }) as Express.Multer.File;

describe('MenuImagesService', () => {
  let prisma: any;
  let service: MenuImagesService;
  let storage: {
    upload: jest.Mock;
    remove: jest.Mock;
    getPublicUrl: jest.Mock;
  };
  let bucket: jest.SpyInstance;
  let warning: jest.SpyInstance;
  let errorLog: jest.SpyInstance;
  let png: Buffer;

  const config = (enabled = true) =>
    new ConfigService({
      SUPABASE_IMAGES_ENABLED: enabled,
      SUPABASE_URL: origin,
      SUPABASE_SERVICE_ROLE_KEY: 'test-only-storage-key',
    });

  beforeAll(async () => {
    png = await sharp({
      create: { width: 32, height: 24, channels: 3, background: '#ce5050' },
    })
      .png()
      .toBuffer();
  });
  beforeEach(() => {
    storage = {
      upload: jest.fn().mockResolvedValue({ error: null }),
      remove: jest.fn().mockResolvedValue({ error: null }),
      getPublicUrl: jest.fn((key: string) => ({
        data: { publicUrl: urlFor(key) },
      })),
    };
    jest
      .spyOn(StorageClient.prototype, 'from')
      .mockReturnValue(storage as never);
    bucket = jest
      .spyOn(StorageClient.prototype, 'getBucket')
      .mockResolvedValue({ data: { public: true }, error: null } as never);
    warning = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    errorLog = jest.spyOn(Logger.prototype, 'error').mockImplementation();
    prisma = {
      menuImageUpload: {
        create: jest.fn().mockResolvedValue({}),
        update: jest.fn().mockResolvedValue({}),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        findUnique: jest.fn().mockResolvedValue({ id: 'upload-id' }),
        findMany: jest.fn().mockResolvedValue([]),
        deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      actionLog: { create: jest.fn().mockResolvedValue({}) },
      $transaction: jest.fn((task: (tx: any) => unknown) => task(prisma)),
    };
    service = new MenuImagesService(prisma as never, config());
  });
  afterEach(() => jest.restoreAllMocks());

  it('is off by default, reveals no credentials and does not query storage or DB', async () => {
    service = new MenuImagesService(prisma as never, new ConfigService());
    expect(service.policy()).toEqual({
      enabled: false,
      maxBytes: MENU_IMAGE_MAX_BYTES,
      mimeTypes: ['image/jpeg', 'image/png', 'image/webp'],
    });
    await expect(service.upload('actor', file(png))).rejects.toMatchObject({
      response: { code: 'IMAGE_UPLOAD_DISABLED' },
    });
    await service.cleanupExpired();
    expect(bucket).not.toHaveBeenCalled();
    expect(prisma.menuImageUpload.findMany).not.toHaveBeenCalled();
  });

  it('strips metadata, resizes and encodes WebP; persists intent before the remote write', async () => {
    const source = await sharp({
      create: { width: 1800, height: 900, channels: 3, background: '#ce5050' },
    })
      .withMetadata()
      .jpeg()
      .toBuffer();
    const result = await service.upload('actor', file(source, 'image/jpeg'));
    const [key, bytes, options] = storage.upload.mock.calls[0] as [
      string,
      Buffer,
      unknown,
    ];
    expect(key).toMatch(/^managed-menu\/[\da-f-]+\.webp$/);
    expect(options).toEqual({
      contentType: 'image/webp',
      cacheControl: '31536000',
      upsert: false,
    });
    expect(await sharp(bytes).metadata()).toMatchObject({
      format: 'webp',
      width: 1600,
      height: 800,
    });
    expect((await sharp(bytes).metadata()).exif).toBeUndefined();
    expect(
      prisma.menuImageUpload.create.mock.invocationCallOrder[0],
    ).toBeLessThan(storage.upload.mock.invocationCallOrder[0]);
    expect(prisma.menuImageUpload.updateMany).toHaveBeenCalledWith({
      where: {
        id: result.id,
        status: MenuImageStatus.UPLOADING,
        expiresAt: { gt: expect.any(Date) },
      },
      data: { status: MenuImageStatus.READY },
    });
    expect(result.url).toBe(urlFor(key));
    expect(new Date(result.expiresAt).getTime() - Date.now()).toBeGreaterThan(
      23 * 60 * 60_000,
    );
    expect(prisma.actionLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          actionType: 'MENU_IMAGE_UPLOADED',
          employeeId: 'actor',
        }),
      }),
    );
  });

  it.each([
    ['missing', undefined],
    ['empty', file(Buffer.alloc(0))],
    ['oversize', file(Buffer.alloc(MENU_IMAGE_MAX_BYTES + 1))],
    ['SVG', file(Buffer.from('<svg/>'), 'image/svg+xml')],
    ['fake PNG', file(Buffer.from('not an image'))],
    ['mismatched MIME', () => file(png, 'image/jpeg')],
    ['corrupt PNG', file(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))],
  ])('rejects %s before any storage write', async (_label, input) => {
    await expect(
      service.upload('actor', typeof input === 'function' ? input() : input),
    ).rejects.toMatchObject({ response: { code: 'IMAGE_UPLOAD_INVALID' } });
    expect(storage.upload).not.toHaveBeenCalled();
    expect(prisma.menuImageUpload.create).not.toHaveBeenCalled();
  });

  it('rejects excessive decoded pixels and animated images', async () => {
    const huge = await sharp({
      create: { width: 4001, height: 4000, channels: 3, background: '#fff' },
    })
      .png()
      .toBuffer();
    const blue = await sharp({
      create: { width: 32, height: 24, channels: 3, background: '#0055ee' },
    })
      .png()
      .toBuffer();
    const animated = await sharp([png, blue], { join: { animated: true } })
      .webp()
      .toBuffer();
    expect((await sharp(animated, { animated: true }).metadata()).pages).toBe(
      2,
    );
    for (const input of [file(huge), file(animated, 'image/webp')]) {
      await expect(service.upload('actor', input)).rejects.toMatchObject({
        response: { code: 'IMAGE_UPLOAD_INVALID' },
      });
    }
    expect(storage.upload).not.toHaveBeenCalled();
  });

  it('requires a public bucket and retains intent on an uncertain provider write', async () => {
    bucket.mockResolvedValueOnce({ data: { public: false }, error: null });
    await expect(service.upload('actor', file(png))).rejects.toMatchObject({
      response: { code: 'IMAGE_STORAGE_UNAVAILABLE' },
    });
    expect(prisma.menuImageUpload.create).not.toHaveBeenCalled();
    storage.upload.mockRejectedValueOnce(new Error('sensitive-provider-error'));
    await expect(service.upload('actor', file(png))).rejects.toMatchObject({
      response: { code: 'IMAGE_STORAGE_UNAVAILABLE' },
    });
    expect(prisma.menuImageUpload.create).toHaveBeenCalledTimes(1);
    expect(prisma.menuImageUpload.updateMany).not.toHaveBeenCalled();
    expect(prisma.menuImageUpload.deleteMany).not.toHaveBeenCalled();
    expect(warning).toHaveBeenLastCalledWith({
      event: 'menu.image.storage.unavailable',
      operation: 'upload',
    });
  });

  it('bounds concurrent processing and releases the slot after completion', async () => {
    let release!: (value: unknown) => void;
    const pending = new Promise((resolve) => {
      release = resolve;
    });
    bucket.mockReturnValue(pending);
    const first = service.upload('actor', file(png));
    const second = service.upload('actor', file(png));
    await expect(service.upload('actor', file(png))).rejects.toMatchObject({
      status: 429,
      response: { code: 'IMAGE_UPLOAD_BUSY' },
    });
    release({ data: { public: true }, error: null });
    await first;
    await second;
    await expect(service.upload('actor', file(png))).resolves.toHaveProperty(
      'url',
    );
  });

  it('does not resurrect an upload already expired or claimed by cleanup', async () => {
    prisma.menuImageUpload.updateMany.mockResolvedValueOnce({ count: 0 });
    await expect(service.upload('actor', file(png))).rejects.toMatchObject({
      response: { code: 'IMAGE_UPLOAD_NOT_AVAILABLE' },
    });
    expect(prisma.actionLog.create).not.toHaveBeenCalled();
    expect(storage.remove).not.toHaveBeenCalled();
  });

  it('attaches only an owned, unexpired draft or the same already attached item', async () => {
    await service.syncReference(
      prisma as never,
      'actor',
      'item',
      urlFor('managed-menu/id.webp'),
    );
    expect(prisma.menuImageUpload.updateMany).toHaveBeenNthCalledWith(1, {
      where: {
        id: 'upload-id',
        OR: [
          {
            status: MenuImageStatus.READY,
            employeeId: 'actor',
            menuItemId: null,
            expiresAt: { gt: expect.any(Date) },
          },
          { status: MenuImageStatus.ATTACHED, menuItemId: 'item' },
        ],
      },
      data: {
        status: MenuImageStatus.ATTACHED,
        menuItemId: 'item',
        expiresAt: null,
      },
    });
    prisma.menuImageUpload.updateMany.mockResolvedValueOnce({ count: 0 });
    await expect(
      service.syncReference(
        prisma as never,
        'other',
        'other-item',
        urlFor('managed-menu/id.webp'),
      ),
    ).rejects.toMatchObject({
      response: { code: 'IMAGE_UPLOAD_NOT_AVAILABLE' },
    });
  });

  it.each([
    'managed-menu/missing.webp',
    'managed-menu/missing.webp?version=1',
    '%6danaged-menu/missing.webp',
  ])(
    'rejects missing managed image %s, even with uploads disabled',
    async (path) => {
      service = new MenuImagesService(prisma as never, config(false));
      prisma.menuImageUpload.findUnique.mockResolvedValue(null);
      await expect(
        service.syncReference(prisma as never, 'actor', 'item', urlFor(path)),
      ).rejects.toMatchObject({
        response: { code: 'IMAGE_UPLOAD_NOT_AVAILABLE' },
      });
      expect(prisma.menuImageUpload.updateMany).not.toHaveBeenCalled();
    },
  );

  it.each([null, 'https://legacy.example.test/image.jpg'])(
    'preserves manual URLs and queues only replaced images: %s',
    async (url) => {
      prisma.menuImageUpload.findUnique.mockResolvedValue(null);
      await service.syncReference(prisma as never, 'actor', 'item', url);
      expect(prisma.menuImageUpload.updateMany).toHaveBeenCalledWith({
        where: {
          menuItemId: 'item',
          status: MenuImageStatus.ATTACHED,
          ...(url ? { url: { not: url } } : {}),
        },
        data: { status: MenuImageStatus.DELETING, expiresAt: expect.any(Date) },
      });
      expect(storage.remove).not.toHaveBeenCalled();
    },
  );

  describe('cleanup', () => {
    const key = 'managed-menu/expired.webp';
    beforeEach(() =>
      prisma.menuImageUpload.findMany.mockResolvedValue([
        { id: 'expired', objectKey: key, url: urlFor(key) },
      ]),
    );

    it('does not remove an image attached or claimed by another worker', async () => {
      prisma.menuImageUpload.updateMany.mockResolvedValue({ count: 0 });
      await service.cleanupExpired();
      expect(storage.remove).not.toHaveBeenCalled();
      expect(prisma.menuImageUpload.deleteMany).not.toHaveBeenCalled();
    });
    it('fences both the remote deletion and tracker removal', async () => {
      const first = service.cleanupExpired();
      expect(service.cleanupExpired()).toBe(first);
      await first;
      const claim = prisma.menuImageUpload.updateMany.mock.calls[0][0];
      expect(claim.where.status.in).not.toContain(MenuImageStatus.ATTACHED);
      expect(claim.where.expiresAt.lte).toBeInstanceOf(Date);
      expect(storage.remove).toHaveBeenCalledWith([key]);
      expect(prisma.menuImageUpload.deleteMany).toHaveBeenCalledWith({
        where: {
          id: 'expired',
          status: MenuImageStatus.DELETING,
          expiresAt: claim.data.expiresAt,
        },
      });
    });
    it('retains failed removals for retry without logging provider secrets', async () => {
      storage.remove.mockRejectedValue(new Error('secret-key'));
      await service.cleanupExpired();
      expect(prisma.menuImageUpload.deleteMany).not.toHaveBeenCalled();
      expect(warning).toHaveBeenCalledWith({
        event: 'menu.image.cleanup.failed',
        uploadId: 'expired',
      });
    });
    it('never deletes from another project after configuration changes', async () => {
      prisma.menuImageUpload.findMany.mockResolvedValue([
        {
          id: 'old-project',
          objectKey: key,
          url: `https://old.example.test/${key}`,
        },
      ]);
      await service.cleanupExpired();
      expect(storage.remove).not.toHaveBeenCalled();
      expect(errorLog).toHaveBeenCalledWith({
        event: 'menu.image.cleanup.configuration_mismatch',
        uploadId: 'old-project',
      });
    });
  });
});
