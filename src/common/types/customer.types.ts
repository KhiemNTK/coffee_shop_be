import type { Request } from 'express';
import type {
  OnlineOrderRequest,
  OnlineOrderRequestItem,
} from '@prisma/client';

export type CustomerContext = { id: string; email: string };
export type CustomerRequest = Request & {
  customer: CustomerContext;
};

export type CustomerReorderSource = Pick<
  OnlineOrderRequest,
  'quotedSubtotal'
> & {
  items: Array<
    Pick<
      OnlineOrderRequestItem,
      | 'menuItemId'
      | 'quantity'
      | 'note'
      | 'quotedName'
      | 'quotedUnitPrice'
      | 'quotedOptions'
    >
  >;
};
