import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { PaymentProvider, Prisma } from '@prisma/client';
import { MomoService } from './momo.service';
import { VnpayService } from './vnpay.service';

@Injectable()
export class PaymentProviderFactory {
  constructor(
    private readonly vnpay: VnpayService,
    private readonly momo: MomoService,
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

  get(provider: PaymentProvider): VnpayService | MomoService {
    switch (provider) {
      case PaymentProvider.VNPAY:
        return this.vnpay;
      case PaymentProvider.MOMO:
        return this.momo;
    }
  }

  createPaymentUrl(
    provider: PaymentProvider,
    input: {
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
    return this.vnpay.createPaymentUrl(input);
  }
}
