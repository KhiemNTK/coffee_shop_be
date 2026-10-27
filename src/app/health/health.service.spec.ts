import { ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { ExtendedPrismaClient } from '../../common/prisma/prisma.service';
import { HealthService } from './health.service';
import Redis from 'ioredis';
import { createServer } from 'node:net';
import type { Socket } from 'node:net';

describe('HealthService', () => {
  const createService = (nodeEnvironment: string) => {
    const prisma = { $queryRaw: jest.fn().mockResolvedValue([{ result: 1 }]) };
    const config = {
      get: jest.fn((key: string, fallback?: unknown) => {
        if (key === 'NODE_ENV') return nodeEnvironment;
        if (key === 'REDIS_URL') return undefined;
        return fallback;
      }),
    };

    return new HealthService(
      prisma as unknown as ExtendedPrismaClient,
      config as unknown as ConfigService,
    );
  };

  it('reports Redis as disabled outside production when it is not configured', async () => {
    await expect(createService('test').readiness()).resolves.toEqual({
      status: 'ready',
      dependencies: { database: 'up', redis: 'disabled' },
    });
  });

  it('fails readiness immediately when draining without disconnecting dependencies', async () => {
    const service = createService('test');
    const disconnect = jest.fn();
    Reflect.set(service, 'redis', { disconnect });
    service.beginShutdown();
    await expect(service.readiness()).rejects.toMatchObject({
      response: { code: 'SERVICE_NOT_READY' },
    });
    expect(disconnect).not.toHaveBeenCalled();
    service.onModuleDestroy();
    expect(disconnect).toHaveBeenCalledTimes(1);
  });

  it('does not report ready when shutdown starts during a pending dependency check', async () => {
    const pending = Promise.withResolvers<[]>();
    const service = createService('test');
    Reflect.set(service, 'prisma', { $queryRaw: () => pending.promise });
    const check = service.readiness();
    service.beginShutdown();
    pending.resolve([]);
    await expect(check).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it('fails readiness when production Redis is not configured', async () => {
    await expect(createService('production').readiness()).rejects.toThrow(
      ServiceUnavailableException,
    );
  });

  it('reports a missing optional Redis dependency as disabled', async () => {
    await expect(createService('test').redisStatus()).resolves.toBe('disabled');
  });

  it('fails readiness when PostgreSQL is unavailable', async () => {
    const prisma = {
      $queryRaw: jest.fn().mockRejectedValue(new Error('connection exhausted')),
    };
    const config = {
      get: jest.fn((key: string, fallback?: unknown) => {
        if (key === 'NODE_ENV') return 'test';
        if (key === 'REDIS_URL') return undefined;
        return fallback;
      }),
    };
    const service = new HealthService(
      prisma as unknown as ExtendedPrismaClient,
      config as unknown as ConfigService,
    );

    await expect(service.readiness()).rejects.toThrow(
      ServiceUnavailableException,
    );
  });

  it('bounds a silent Redis handshake, shares concurrent checks, and can recover', async () => {
    jest.useFakeTimers();
    const service = createService('production');
    const redis = {
      status: 'wait',
      connect: jest.fn(() => new Promise<void>(() => {})),
      ping: jest.fn().mockResolvedValue('PONG'),
      disconnect: jest.fn(),
    };
    Reflect.set(service, 'redis', redis);
    try {
      const first = service.redisStatus();
      const second = service.redisStatus();
      await jest.advanceTimersByTimeAsync(1500);
      expect(await first).toBe('down');
      expect(await second).toBe('down');
      expect(redis.connect).toHaveBeenCalledTimes(1);
      expect(redis.disconnect).toHaveBeenCalledWith(true);
      redis.status = 'ready';
      expect(await service.redisStatus()).toBe('up');
      service.onModuleDestroy();
      expect(await service.redisStatus()).toBe('down');
      expect(jest.getTimerCount()).toBe(0);
    } finally {
      service.onModuleDestroy();
      jest.useRealTimers();
    }
  });

  it('fails readiness within a deadline when a real TCP server never answers Redis commands', async () => {
    const sockets = new Set<Socket>();
    const server = createServer((socket) => {
      sockets.add(socket);
      socket.on('data', () => undefined);
      socket.on('close', () => sockets.delete(socket));
    });
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
    const address = server.address();
    if (!address || typeof address === 'string')
      throw new Error('Test server missing');
    const service = new HealthService(
      { $queryRaw: jest.fn().mockResolvedValue([]) } as never,
      new ConfigService({
        NODE_ENV: 'production',
        REDIS_URL: `redis://127.0.0.1:${address.port}`,
      }),
    );
    try {
      const started = Date.now();
      await expect(service.readiness()).rejects.toBeInstanceOf(
        ServiceUnavailableException,
      );
      expect(Date.now() - started).toBeLessThan(2500);
      expect(
        (Reflect.get(service, 'redis') as Redis).options.commandTimeout,
      ).toBe(1000);
    } finally {
      service.onModuleDestroy();
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('parses bounded Redis memory fields without exposing raw INFO data', async () => {
    const service = createService('test');
    const info = jest
      .fn()
      .mockResolvedValue('# Memory\r\nused_memory:1234\r\nmaxmemory:4096\r\n');
    Reflect.set(service, 'redis', { info, disconnect: jest.fn() });
    try {
      expect(await service.redisMemory()).toEqual({ used: 1234, limit: 4096 });
      info.mockResolvedValue('used_memory:invalid\r\nmaxmemory:4096\r\n');
      await expect(service.redisMemory()).rejects.toThrow(
        'Invalid Redis memory metrics',
      );
    } finally {
      service.onModuleDestroy();
    }
  });
});
