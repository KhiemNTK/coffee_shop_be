import { createHash } from 'node:crypto';
import { UnauthorizedException } from '@nestjs/common';
import type { ExecutionContext } from '@nestjs/common';
import { PrintDeviceGuard } from './print-device.guard';

describe('PrintDeviceGuard', () => {
  const apiKey = 'print-agent-secret';
  const device = {
    id: 'device-id',
    type: 'RECEIPT',
    status: 'READY',
    apiKeyHash: createHash('sha256').update(apiKey).digest('hex'),
  };

  const context = (headers: Record<string, string>) => {
    const request = { headers };
    return {
      request,
      executionContext: {
        switchToHttp: () => ({ getRequest: () => request }),
      } as unknown as ExecutionContext,
    };
  };

  it('attaches an authenticated device without exposing its key hash', async () => {
    const prisma = {
      printDevice: { findFirst: jest.fn().mockResolvedValue(device) },
    };
    const guard = new PrintDeviceGuard(prisma as never);
    const { request, executionContext } = context({
      'x-print-device-id': device.id,
      'x-print-device-key': apiKey,
    });

    await expect(guard.canActivate(executionContext)).resolves.toBe(true);
    expect(request).toHaveProperty('printDevice', {
      id: device.id,
      type: device.type,
      status: device.status,
    });
  });

  it('rejects an invalid device key', async () => {
    const prisma = {
      printDevice: { findFirst: jest.fn().mockResolvedValue(device) },
    };
    const guard = new PrintDeviceGuard(prisma as never);
    const { executionContext } = context({
      'x-print-device-id': device.id,
      'x-print-device-key': 'wrong-key',
    });

    await expect(guard.canActivate(executionContext)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });
});
