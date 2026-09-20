import { Global, Module } from '@nestjs/common';
import { DomainEventBusService } from './domain-event-bus.service';
import { IdempotencyService } from './idempotency.service';
import { OutboxDispatcherService } from './outbox-dispatcher.service';
import { OutboxService } from './outbox.service';

@Global()
@Module({
  providers: [
    DomainEventBusService,
    IdempotencyService,
    OutboxService,
    OutboxDispatcherService,
  ],
  exports: [DomainEventBusService, IdempotencyService, OutboxService],
})
export class DurableModule {}
