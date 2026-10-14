import type { Request } from 'express';

export type CustomerContext = { id: string; email: string };
export type CustomerRequest = Request & {
  customer: CustomerContext;
};
