import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ThrottlerModule } from '@nestjs/throttler';
import { RateLimitEnvs } from './rate-limit.const';

@Module({
  imports: [
    ThrottlerModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const ttlEnv =
          config.get<string>(RateLimitEnvs.THROTTLE_TTL) ?? '60000';
        const limitEnv =
          config.get<string>(RateLimitEnvs.THROTTLE_LIMIT) ?? '10';

        return [
          {
            ttl: parseInt(ttlEnv),
            limit: parseInt(limitEnv),
          },
        ];
      },
    }),
  ],
})
export class RateLimitModule {}
