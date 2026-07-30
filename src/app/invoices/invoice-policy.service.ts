import { BadRequestException, Injectable } from '@nestjs/common';
import {
  PaymentMethod,
  PaymentStatus,
  ServeStatus,
  SessionStatus,
} from '@prisma/client';
import { Decimal } from '@prisma/client/runtime/library';
import type { InvoiceLineSnapshot } from '../../common/types';

@Injectable()
export class InvoicePolicyService {
  assertActiveSession(sessionStatus: SessionStatus) {
    if (sessionStatus !== SessionStatus.ACTIVE) {
      throw new BadRequestException(
        'Cannot create invoice for an inactive session.',
      );
    }
  }

  assertActiveEmployee(employee: { isActive: boolean } | null) {
    if (!employee?.isActive) {
      throw new BadRequestException('Employee is inactive or not found.');
    }
  }

  assertInvoiceIsPending(invoice: { paymentStatus: PaymentStatus }) {
    if (invoice.paymentStatus !== PaymentStatus.PENDING) {
      throw new BadRequestException('Only pending invoices can be changed.');
    }
  }

  assertInvoiceItemsAreBillable(items: InvoiceLineSnapshot[]) {
    if (items.length === 0) {
      throw new BadRequestException('No billable order items found.');
    }

    const invalidItem = items.find(
      (item) =>
        item.serveStatus === ServeStatus.CANCELLED ||
        item.isPaid ||
        item.invoiceId,
    );

    if (invalidItem) {
      throw new BadRequestException(
        `Order item ${invalidItem.id} cannot be invoiced.`,
      );
    }
  }

  assertPaidPaymentAmount({
    paymentMethod,
    amountTendered,
    totalAmount,
  }: {
    paymentMethod: PaymentMethod;
    amountTendered: Decimal | null;
    totalAmount: Decimal;
  }) {
    if (paymentMethod === PaymentMethod.CASH && !amountTendered) {
      throw new BadRequestException('Cash payment requires amountTendered.');
    }

    if (amountTendered && amountTendered.lt(totalAmount)) {
      throw new BadRequestException(
        'Amount tendered is less than total amount.',
      );
    }
  }
}
