import { randomUUID } from 'node:crypto';
import {
  BadRequestException,
  ConflictException,
  HttpException,
  Inject,
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MenuImageStatus } from '@prisma/client';
import { StorageClient } from '@supabase/storage-js';
import sharp from 'sharp';
import {
  MENU_IMAGE_DRAFT_TTL_MS,
  MENU_IMAGE_MAX_BYTES,
  MENU_IMAGE_MIME_TYPES,
  MENU_IMAGE_PREFIX,
} from '../../common/consts/menu-images';
import {
  PRISMA_SERVICE_TOKEN,
  type ExtendedPrismaClient,
} from '../../common/prisma/prisma.service';
import type { ExtendedPrismaTransactionClient } from '../../common/types';

@Injectable()
export class MenuImagesService
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private readonly logger = new Logger(MenuImagesService.name);
  private readonly storage?: StorageClient;
  private readonly bucket: string;
  private readonly publicPrefix?: URL;
  private timer?: NodeJS.Timeout;
  private cleanupFlight?: Promise<void>;
  private stopping = false;
  private processing = 0;

  constructor(
    @Inject(PRISMA_SERVICE_TOKEN) private readonly prisma: ExtendedPrismaClient,
    config: ConfigService,
  ) {
    this.bucket = config.get<string>('SUPABASE_MENU_BUCKET', 'menu-images');
    const origin = config.get<string>('SUPABASE_URL');
    const key = config.get<string>('SUPABASE_SERVICE_ROLE_KEY');
    if (origin)
      this.publicPrefix = new URL(
        `/storage/v1/object/public/${this.bucket}/${MENU_IMAGE_PREFIX}`,
        origin,
      );
    if (
      config.get<boolean>('SUPABASE_IMAGES_ENABLED', false) &&
      origin &&
      key
    ) {
      this.storage = new StorageClient(
        `${origin.replace(/\/$/, '')}/storage/v1`,
        {
          apikey: key,
          Authorization: `Bearer ${key}`,
        },
        (
          input: Parameters<typeof fetch>[0],
          init?: Parameters<typeof fetch>[1],
        ) =>
          fetch(input, {
            ...init,
            signal: AbortSignal.any([
              ...(init?.signal ? [init.signal] : []),
              AbortSignal.timeout(10_000),
            ]),
            redirect: 'error',
          }),
      );
    }
  }

  policy() {
    return {
      enabled: Boolean(this.storage),
      maxBytes: MENU_IMAGE_MAX_BYTES,
      mimeTypes: MENU_IMAGE_MIME_TYPES,
    };
  }

  onApplicationBootstrap() {
    if (!this.storage) return;
    this.timer = setInterval(() => void this.cleanupExpired(), 60_000);
    this.timer.unref();
    void this.cleanupExpired();
  }

  async onModuleDestroy() {
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
    await this.cleanupFlight;
  }

  async upload(employeeId: string, file?: Express.Multer.File) {
    const storage = this.storage;
    if (!storage)
      throw new ServiceUnavailableException({
        code: 'IMAGE_UPLOAD_DISABLED',
        message: 'Image uploads are not configured.',
      });
    if (this.processing >= 2)
      throw new HttpException(
        {
          code: 'IMAGE_UPLOAD_BUSY',
          message: 'Image processing is busy. Try again shortly.',
        },
        429,
      );
    this.processing++;
    try {
      const bytes = await this.normalize(file);
      const bucket = await storage.getBucket(this.bucket).catch(() => null);
      if (bucket?.error || !bucket?.data?.public)
        throw this.unavailable('bucket');
      const id = randomUUID();
      const objectKey = `${MENU_IMAGE_PREFIX}${id}.webp`;
      const url = storage.from(this.bucket).getPublicUrl(objectKey)
        .data.publicUrl;
      const expiresAt = new Date(Date.now() + MENU_IMAGE_DRAFT_TTL_MS);
      // Persist intent before the remote write; even an uncertain upload can be reclaimed.
      await this.prisma.menuImageUpload.create({
        data: { id, objectKey, url, employeeId, expiresAt },
      });
      const uploaded = await storage
        .from(this.bucket)
        .upload(objectKey, bytes, {
          contentType: 'image/webp',
          cacheControl: '31536000',
          upsert: false,
        })
        .catch(() => null);
      if (!uploaded || uploaded.error) throw this.unavailable('upload');
      await this.prisma.$transaction(async (tx) => {
        const ready = await tx.menuImageUpload.updateMany({
          where: {
            id,
            status: MenuImageStatus.UPLOADING,
            expiresAt: { gt: new Date() },
          },
          data: { status: MenuImageStatus.READY },
        });
        if (ready.count !== 1) throw this.expired();
        await tx.actionLog.create({
          data: {
            employeeId,
            actionType: 'MENU_IMAGE_UPLOADED',
            details: { uploadId: id, sizeBytes: bytes.length },
          },
        });
      });
      return { id, url, expiresAt: expiresAt.toISOString() };
    } finally {
      this.processing--;
    }
  }

  async syncReference(
    tx: ExtendedPrismaTransactionClient,
    employeeId: string,
    menuItemId: string,
    url?: string | null,
  ) {
    if (url) {
      const asset = await tx.menuImageUpload.findUnique({
        where: { url },
        select: { id: true },
      });
      if (asset) {
        const attached = await tx.menuImageUpload.updateMany({
          where: {
            id: asset.id,
            OR: [
              {
                status: MenuImageStatus.READY,
                employeeId,
                menuItemId: null,
                expiresAt: { gt: new Date() },
              },
              { status: MenuImageStatus.ATTACHED, menuItemId },
            ],
          },
          data: {
            status: MenuImageStatus.ATTACHED,
            menuItemId,
            expiresAt: null,
          },
        });
        if (attached.count !== 1) throw this.expired();
      } else if (this.isManagedUrl(url)) {
        throw this.expired();
      }
    }
    // Grace protects readers with a cached menu; only tracked, replaced files are reclaimed.
    await tx.menuImageUpload.updateMany({
      where: {
        menuItemId,
        status: MenuImageStatus.ATTACHED,
        ...(url ? { url: { not: url } } : {}),
      },
      data: {
        status: MenuImageStatus.DELETING,
        expiresAt: new Date(Date.now() + MENU_IMAGE_DRAFT_TTL_MS),
      },
    });
  }

  cleanupExpired(): Promise<void> {
    if (!this.storage || this.stopping) return Promise.resolve();
    if (!this.cleanupFlight)
      this.cleanupFlight = this.cleanupBatch().finally(() => {
        this.cleanupFlight = undefined;
      });
    return this.cleanupFlight;
  }

  private async cleanupBatch() {
    try {
      const now = new Date();
      const candidates = await this.prisma.menuImageUpload.findMany({
        where: {
          status: {
            in: [
              MenuImageStatus.UPLOADING,
              MenuImageStatus.READY,
              MenuImageStatus.DELETING,
            ],
          },
          expiresAt: { lte: now },
        },
        orderBy: [{ expiresAt: 'asc' }, { id: 'asc' }],
        take: 25,
        select: { id: true, objectKey: true, url: true },
      });
      for (const asset of candidates) {
        if (this.stopping) break;
        const expected = this.storage!.from(this.bucket).getPublicUrl(
          asset.objectKey,
        ).data.publicUrl;
        if (asset.url !== expected) {
          this.logger.error({
            event: 'menu.image.cleanup.configuration_mismatch',
            uploadId: asset.id,
          });
          await this.prisma.menuImageUpload.updateMany({
            where: {
              id: asset.id,
              status: { not: MenuImageStatus.ATTACHED },
              expiresAt: { lte: now },
            },
            data: { expiresAt: new Date(Date.now() + MENU_IMAGE_DRAFT_TTL_MS) },
          });
          continue;
        }
        const lease = new Date(Date.now() + 5 * 60_000);
        // Conditional update fences attachment and competing workers before deleting any object.
        const claimed = await this.prisma.menuImageUpload.updateMany({
          where: {
            id: asset.id,
            status: {
              in: [
                MenuImageStatus.UPLOADING,
                MenuImageStatus.READY,
                MenuImageStatus.DELETING,
              ],
            },
            expiresAt: { lte: now },
          },
          data: { status: MenuImageStatus.DELETING, expiresAt: lease },
        });
        if (!claimed.count) continue;
        const removed = await this.storage!.from(this.bucket)
          .remove([asset.objectKey])
          .catch(() => null);
        if (!removed || removed.error) {
          this.logger.warn({
            event: 'menu.image.cleanup.failed',
            uploadId: asset.id,
          });
          continue;
        }
        await this.prisma.menuImageUpload.deleteMany({
          where: {
            id: asset.id,
            status: MenuImageStatus.DELETING,
            expiresAt: lease,
          },
        });
      }
    } catch {
      this.logger.error({ event: 'menu.image.cleanup.cycle_failed' });
    }
  }

  private isManagedUrl(value: string) {
    if (!this.publicPrefix) return false;
    try {
      const url = new URL(value);
      return (
        url.origin === this.publicPrefix.origin &&
        decodeURIComponent(url.pathname).startsWith(this.publicPrefix.pathname)
      );
    } catch {
      return false;
    }
  }

  private expired() {
    return new ConflictException({
      code: 'IMAGE_UPLOAD_NOT_AVAILABLE',
      message:
        'This image upload is unavailable or expired. Upload the image again.',
    });
  }

  private unavailable(operation: string) {
    this.logger.warn({ event: 'menu.image.storage.unavailable', operation });
    return new ServiceUnavailableException({
      code: 'IMAGE_STORAGE_UNAVAILABLE',
      message: 'Image storage is unavailable.',
    });
  }

  private async normalize(file?: Express.Multer.File) {
    const invalid = () =>
      new BadRequestException({
        code: 'IMAGE_UPLOAD_INVALID',
        message:
          'Use a valid, static JPEG, PNG or WebP image up to 2 MB and 16 megapixels.',
      });
    if (!file?.buffer?.length || file.buffer.length > MENU_IMAGE_MAX_BYTES)
      throw invalid();
    const bytes = file.buffer;
    const format =
      file.mimetype === 'image/jpeg' &&
      bytes.subarray(0, 3).equals(Buffer.from([255, 216, 255]))
        ? 'jpeg'
        : file.mimetype === 'image/png' &&
            bytes
              .subarray(0, 8)
              .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
          ? 'png'
          : file.mimetype === 'image/webp' &&
              bytes.toString('ascii', 0, 4) === 'RIFF' &&
              bytes.toString('ascii', 8, 12) === 'WEBP'
            ? 'webp'
            : null;
    if (!format) throw invalid();
    try {
      const image = sharp(bytes, {
        limitInputPixels: 16_000_000,
        failOn: 'warning',
      });
      const metadata = await image.metadata();
      if (metadata.format !== format || (metadata.pages ?? 1) > 1)
        throw invalid();
      return await image
        .rotate()
        .resize({
          width: 1600,
          height: 1600,
          fit: 'inside',
          withoutEnlargement: true,
        })
        .webp({ quality: 82 })
        .timeout({ seconds: 5 })
        .toBuffer();
    } catch {
      throw invalid();
    }
  }
}
