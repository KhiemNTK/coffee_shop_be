import { Injectable, Module, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  ThrottlerModule,
  type ThrottlerModuleOptions,
  type ThrottlerOptionsFactory,
} from '@nestjs/throttler';
import { RedisThrottlerStorage } from './redis-throttler.storage';

@Injectable()
class RateLimitOptionsFactory
  implements ThrottlerOptionsFactory, OnModuleDestroy
{
  private storage?: RedisThrottlerStorage;

  constructor(private readonly config: ConfigService) {}

  createThrottlerOptions(): ThrottlerModuleOptions {
    const redisUrl = this.config.get<string>('REDIS_URL');
    if (redisUrl) this.storage = new RedisThrottlerStorage(redisUrl);

    return {
      throttlers: [
        {
          ttl: this.config.get<number>('THROTTLE_TTL', 60_000),
          limit: this.config.get<number>('THROTTLE_LIMIT', 100),
        },
      ],
      ...(this.storage ? { storage: this.storage } : {}),
    };
  }

  onModuleDestroy() {
    this.storage?.disconnect();
  }
}

@Module({
  imports: [
    ThrottlerModule.forRootAsync({
      useClass: RateLimitOptionsFactory,
    }),
  ],
})
export class RateLimitModule {}
