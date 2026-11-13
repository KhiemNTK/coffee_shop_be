import { ConflictException } from '@nestjs/common';
import type { CustomerRequest } from '../../common/types';
import { CustomerVouchersController } from './customer-vouchers.controller';
import {
  GetCustomerVouchersDto,
  RevokeCustomerVoucherDto,
} from './dto/voucher.dto';
import type { VouchersService } from './vouchers.service';

describe('CustomerVouchersController', () => {
  it('rejects a changed customer session before claiming', () => {
    const claim = jest.fn();
    const controller = new CustomerVouchersController({
      claim,
    } as unknown as VouchersService);
    expect(() =>
      controller.claim({ customer: { id: 'current' } } as CustomerRequest, {
        campaignId: 'campaign',
        expectedCustomerId: 'previous',
      }),
    ).toThrow(ConflictException);
    expect(claim).not.toHaveBeenCalled();
  });

  it('uses the guarded customer identity for wallet reads and claim writes', async () => {
    const claim = jest
      .fn()
      .mockReturnValue({ customerId: 'customer', voucherId: 'voucher' });
    const getWallet = jest.fn();
    const controller = new CustomerVouchersController({
      claim,
      getWallet,
    } as unknown as VouchersService);
    const request = { customer: { id: 'customer' } } as CustomerRequest;
    const query = GetCustomerVouchersDto.schema.parse({
      page: '1',
      itemPerPage: '20',
      status: 'USED',
    });
    await controller.getWallet(request, query);
    expect(getWallet).toHaveBeenCalledWith('customer', query);
    expect(
      await controller.claim(request, {
        campaignId: 'campaign',
        expectedCustomerId: 'customer',
      }),
    ).toEqual({ customerId: 'customer', voucherId: 'voucher' });
  });

  it('accepts revoke idempotency keys and rejects the internal REDEEMED wallet status', () => {
    expect(
      RevokeCustomerVoucherDto.schema.safeParse({
        reason: 'Correction',
        expectedUpdatedAt: '2026-11-10T00:00:00Z',
        idempotencyKey: 'revoke-key-123',
      }).success,
    ).toBe(true);
    expect(
      GetCustomerVouchersDto.schema.safeParse({ status: 'REDEEMED' }).success,
    ).toBe(false);
  });
});
