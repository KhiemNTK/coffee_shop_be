import { createHash, timingSafeEqual } from 'node:crypto';
import {
  CanActivate,
  ExecutionContext,
  Inject,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request } from 'express';
import {
  PRISMA_SERVICE_TOKEN,
  type ExtendedPrismaClient,
} from '../../common/prisma/prisma.service';
import type { AuthenticatedPrintDevice } from '../../common/types';

@Injectable()
export class PrintDeviceGuard implements CanActivate {
  constructor(
    @Inject(PRISMA_SERVICE_TOKEN)
    private readonly prisma: ExtendedPrismaClient,
  ) {}

  async canActivate(context: ExecutionContext) {
    const request = context
      .switchToHttp()
      .getRequest<Request & { printDevice?: AuthenticatedPrintDevice }>();
    const deviceId = this.header(request, 'x-print-device-id');
    const apiKey = this.header(request, 'x-print-device-key');
    if (!deviceId || !apiKey) {
      throw new UnauthorizedException('Print device credentials are required.');
    }

    const device = await this.prisma.printDevice.findFirst({
      where: { id: deviceId, isActive: true, deletedAt: null },
      select: { id: true, type: true, status: true, apiKeyHash: true },
    });
    if (!device || !this.matches(apiKey, device.apiKeyHash)) {
      throw new UnauthorizedException('Invalid print device credentials.');
    }

    request.printDevice = {
      id: device.id,
      type: device.type,
      status: device.status,
    };
    return true;
  }

  private header(request: Request, name: string) {
    const value = request.headers[name];
    return Array.isArray(value) ? value[0] : value;
  }

  private matches(apiKey: string, expectedHash: string) {
    const actual = Buffer.from(this.hash(apiKey), 'hex');
    const expected = Buffer.from(expectedHash, 'hex');
    return (
      actual.length === expected.length && timingSafeEqual(actual, expected)
    );
  }

  private hash(value: string) {
    return createHash('sha256').update(value).digest('hex');
  }
}
