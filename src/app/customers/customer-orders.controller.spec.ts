import { ConflictException } from '@nestjs/common';
import type { CustomerRequest } from '../../common/types';
import { OnlineOrdersService } from '../online-orders/online-orders.service';
import { CustomerOrdersController } from './customer-orders.controller';
import type { CreateCustomerOrderDto } from './customer.dto';

describe('CustomerOrdersController', () => {
  const request = {
    customer: { id: 'customer-a' },
    ip: '127.0.0.1',
  } as CustomerRequest;
  const service = {
    getCustomerOrders: jest.fn(),
    getCustomerOrder: jest.fn(),
    customerReorderTemplate: jest.fn(),
    createPublicRequest: jest.fn(),
  };
  const controller = new CustomerOrdersController(
    service as unknown as OnlineOrdersService,
  );

  beforeEach(() => jest.resetAllMocks());

  it('identifies the authenticated account in every private read response', async () => {
    service.getCustomerOrders.mockResolvedValue({ list: [], totalItems: 0 });
    service.getCustomerOrder.mockResolvedValue({ requestId: 'order-a' });
    service.customerReorderTemplate.mockResolvedValue({ items: [] });
    expect(
      await controller.getOrders(request, { page: 1, itemPerPage: 10 }),
    ).toEqual({ customerId: 'customer-a', list: [], totalItems: 0 });
    expect(await controller.getOrder(request, { id: 'order-a' })).toEqual({
      customerId: 'customer-a',
      requestId: 'order-a',
    });
    expect(
      await controller.reorderTemplate(request, { id: 'order-a' }),
    ).toEqual({
      customerId: 'customer-a',
      items: [],
    });
    expect(service.getCustomerOrders).toHaveBeenCalledWith('customer-a', {
      page: 1,
      itemPerPage: 10,
    });
    expect(service.getCustomerOrder).toHaveBeenCalledWith(
      'customer-a',
      'order-a',
    );
    expect(service.customerReorderTemplate).toHaveBeenCalledWith(
      'customer-a',
      'order-a',
    );
  });

  it('rejects an account switch before creating an order', () => {
    expect(() =>
      controller.create(request, {
        expectedCustomerId: 'customer-b',
      } as CreateCustomerOrderDto),
    ).toThrow(ConflictException);
    expect(service.createPublicRequest).not.toHaveBeenCalled();
  });
});
