import { Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import type { OrderInvoicePayload } from '../../common/types';
import { DomainEventBusService } from '../durable/domain-event-bus.service';
import { ORDER_EVENTS } from '../orders/events/order.events';
import { PrintingService } from './printing.service';

@Injectable()
export class PrintEventConsumerService
  implements OnModuleInit, OnModuleDestroy
{
  private readonly unsubscribe: Array<() => void> = [];

  constructor(
    private readonly eventBus: DomainEventBusService,
    private readonly printing: PrintingService,
  ) {}

  onModuleInit() {
    this.unsubscribe.push(
      this.eventBus.on(ORDER_EVENTS.INVOICE_PAID, async (payload) => {
        await this.printing.createAutomaticReceipt(
          (payload as OrderInvoicePayload).invoiceId,
        );
      }),
      this.eventBus.on(ORDER_EVENTS.INVOICE_VOIDED, async (payload) => {
        await this.printing.cancelPendingReceiptJobs(
          (payload as OrderInvoicePayload).invoiceId,
        );
      }),
    );
  }

  onModuleDestroy() {
    for (const unsubscribe of this.unsubscribe) unsubscribe();
  }
}
