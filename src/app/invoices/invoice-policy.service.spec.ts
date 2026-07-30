import { BadRequestException } from '@nestjs/common';
import {
  PaymentMethod,
  PaymentStatus,
  ServeStatus,
  SessionStatus,
} from '@prisma/client';
import { Decimal } from '@prisma/client/runtime/library';
import { InvoicePolicyService } from './invoice-policy.service';

describe('InvoicePolicyService', () => {
  let service: InvoicePolicyService;

  beforeEach(() => {
    service = new InvoicePolicyService();
  });

  it('rejects inactive sessions', () => {
    expect(() => service.assertActiveSession(SessionStatus.COMPLETED)).toThrow(
      BadRequestException,
    );
  });

  it('rejects paid, invoiced, or cancelled items', () => {
    expect(() =>
      service.assertInvoiceItemsAreBillable([
        {
          id: 'item-id',
          quantity: 1,
          priceAtTime: new Decimal(100),
          serveStatus: ServeStatus.CANCELLED,
          isPaid: false,
          invoiceId: null,
        },
      ]),
    ).toThrow(BadRequestException);
  });

  it('rejects invalid payment transitions and cash underpayment', () => {
    expect(() =>
      service.assertInvoiceIsPending({ paymentStatus: PaymentStatus.PAID }),
    ).toThrow(BadRequestException);

    expect(() =>
      service.assertPaidPaymentAmount({
        paymentMethod: PaymentMethod.CASH,
        amountTendered: new Decimal(99),
        totalAmount: new Decimal(100),
      }),
    ).toThrow(BadRequestException);
  });
});
