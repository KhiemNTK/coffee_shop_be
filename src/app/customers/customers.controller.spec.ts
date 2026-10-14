import type { Response } from 'express';
import { CUSTOMER_CSRF_COOKIE } from '../../common/consts/customer-auth';
import type { CustomerRequest } from '../../common/types';
import { CustomersController } from './customers.controller';

describe('Customer CSRF recovery', () => {
  it.each(['', null, { attacker: true }])(
    'repairs a malformed readable cookie without touching staff cookies: %p',
    (token) => {
      const response = { cookie: jest.fn() };
      const customer = {
        id: '80000000-0000-4000-8000-000000000001',
        email: 'customer@example.test',
      };
      const request = {
        customer,
        cookies: { [CUSTOMER_CSRF_COOKIE]: token },
      } as unknown as CustomerRequest;
      expect(
        new CustomersController({} as never).me(
          request,
          response as unknown as Response,
        ),
      ).toEqual(customer);
      expect(response.cookie).toHaveBeenCalledTimes(1);
      expect(response.cookie).toHaveBeenCalledWith(
        CUSTOMER_CSRF_COOKIE,
        expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
        expect.objectContaining({ httpOnly: false }),
      );
    },
  );
});
