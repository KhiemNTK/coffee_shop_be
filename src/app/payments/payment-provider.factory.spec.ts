import { ServiceUnavailableException } from '@nestjs/common';
import { PaymentProvider } from '@prisma/client';
import type { VnpayService } from './vnpay.service';
import type { MomoService } from './momo.service';
import { PaymentProviderFactory } from './payment-provider.factory';

describe('PaymentProviderFactory availability', () => {
  it('reports configuration only, without exposing keys or probing a provider', () => {
    const vnpay = { assertConfigured: jest.fn() };
    const momo = {
      assertConfigured: jest.fn(() => {
        throw new ServiceUnavailableException('not configured');
      }),
    };
    const factory = new PaymentProviderFactory(
      vnpay as unknown as VnpayService,
      momo as unknown as MomoService,
    );

    expect(factory.listProviders()).toEqual([
      { provider: PaymentProvider.VNPAY, configured: true },
      { provider: PaymentProvider.MOMO, configured: false },
    ]);
    expect(vnpay.assertConfigured).toHaveBeenCalledTimes(1);
    expect(momo.assertConfigured).toHaveBeenCalledTimes(1);
  });

  it('does not hide unexpected adapter errors as missing configuration', () => {
    const vnpay = {
      assertConfigured: jest.fn(() => {
        throw new Error('unexpected');
      }),
    };
    const factory = new PaymentProviderFactory(
      vnpay as unknown as VnpayService,
      {} as MomoService,
    );
    expect(() => factory.listProviders()).toThrow('unexpected');
  });
});
