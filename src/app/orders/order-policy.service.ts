import { BadRequestException, Injectable } from '@nestjs/common';
import { ServeStatus, SessionStatus } from '@prisma/client';

@Injectable()
export class OrderPolicyService {
  assertActiveSession(sessionStatus: SessionStatus, message?: string) {
    if (sessionStatus !== SessionStatus.ACTIVE) {
      throw new BadRequestException(message ?? 'Order session is not active.');
    }
  }

  assertNoPaidOrInvoicedItems(
    items: Array<{ isPaid: boolean; invoiceId?: string | null }>,
    message: string,
  ) {
    const hasPaidOrInvoiced = items.some(
      (item) => item.isPaid || Boolean(item.invoiceId),
    );

    if (hasPaidOrInvoiced) {
      throw new BadRequestException(message);
    }
  }

  assertNoProcessedItems(
    items: Array<{ serveStatus: ServeStatus }>,
    message: string,
  ) {
    const hasProcessedItems = items.some(
      (item) =>
        item.serveStatus === ServeStatus.COOKING ||
        item.serveStatus === ServeStatus.SERVED,
    );

    if (hasProcessedItems) {
      throw new BadRequestException(message);
    }
  }

  assertItemCanBeChanged(item: {
    isPaid: boolean;
    invoiceId?: string | null;
    serveStatus: ServeStatus;
  }) {
    if (item.isPaid || item.invoiceId) {
      throw new BadRequestException(
        'Cannot change a paid or invoiced order item.',
      );
    }

    if (item.serveStatus === ServeStatus.CANCELLED) {
      throw new BadRequestException('Cannot change a cancelled order item.');
    }
  }
}
