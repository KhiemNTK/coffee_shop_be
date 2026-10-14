import { Inject, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerStorageService } from '@nestjs/throttler';

@Injectable()
export class PaymentWebhookGuard extends ThrottlerGuard {
  constructor(
    @Inject(ThrottlerStorageService) storage: ThrottlerStorageService,
    @Inject(Reflector) reflector: Reflector,
  ) {
    // shortcut: per-instance limit survives Redis outages; coordinate at the edge before adding replicas.
    super(
      [{ name: 'payment-webhook', limit: 600, ttl: 60_000 }],
      storage,
      reflector,
    );
  }
}
