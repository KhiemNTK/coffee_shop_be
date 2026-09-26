import { Module, ModuleMetadata } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { ModuleMocker, MockMetadata } from 'jest-mock';
import { PrismaService } from '../../src/common/prisma/prisma.service';

const moduleMocker = new ModuleMocker(global);

@Module({})
export class AutoMockingModule {
  static async createTestingModule(metadata: ModuleMetadata) {
    return await Test.createTestingModule(metadata)
      .useMocker((token) => {
        if (token === 'PRISMA_SERVICE_TOKEN') {
          return {};
        }

        if (typeof token === 'function') {
          if (token === ConfigService) {
            return {
              get: jest.fn(),
              getOrThrow: jest.fn((key: string) => {
                if (key !== 'JWT_SECRET') {
                  throw new Error(`Unmocked config key: ${key}`);
                }
                return 'test-secret-at-least-32-characters';
              }),
            };
          }
          if (token.name === PrismaService.name) {
            return new (token as any)();
          }

          const mockMetadata = moduleMocker.getMetadata(token) as MockMetadata<
            any,
            any
          >;
          const Mock = moduleMocker.generateFromMetadata(mockMetadata);
          return new Mock();
        }
      })
      .compile();
  }
}
