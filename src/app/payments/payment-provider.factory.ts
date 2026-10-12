import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { PaymentProvider, Prisma } from '@prisma/client';
import { MomoService } from './momo.service';
import { VnpayService } from './vnpay.service';
import { PayosService } from './payos.service';

@Injectable()
export class PaymentProviderFactory {
  constructor(
    private readonly vnpay: VnpayService,
    private readonly momo: MomoService,
    private readonly payos: PayosService,
  ) {}

  listProviders() {
    return Object.values(PaymentProvider).map((provider) => {
      try {
        this.get(provider).assertConfigured();
        return { provider, configured: true };
      } catch (error) {
        if (!(error instanceof ServiceUnavailableException)) throw error;
        return { provider, configured: false };
      }
    });
  }

  get(provider: PaymentProvider): VnpayService | MomoService | PayosService {
    switch (provider) {
      case PaymentProvider.VNPAY:
        return this.vnpay;
      case PaymentProvider.MOMO:
        return this.momo;
      case PaymentProvider.PAYOS:
        return this.payos;
    }
  }

  createPaymentUrl(
    provider: PaymentProvider,
    input: {
      paymentAttemptId: string;
      amount: Prisma.Decimal;
      invoiceNumber: string;
      merchantReference: string;
      ipAddress: string;
      expiresAt: Date;
      providerCreatedAt: Date;
      locale: 'vn' | 'en';
      bankCode?: string;
    },
  ) {
    if (provider === PaymentProvider.MOMO) {
      return this.momo.createPaymentUrl(input);
    }
    if (provider === PaymentProvider.PAYOS)
      return this.payos.createPaymentUrl(input);
    return this.vnpay.createPaymentUrl(input);
  }
}
