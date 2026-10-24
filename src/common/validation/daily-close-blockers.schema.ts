import { z } from 'zod';

export const dailyCloseBlockersSchema = z.object({
  openShifts: z.number().int().nonnegative(),
  unpaidInvoices: z.number().int().nonnegative(),
  unfinishedItems: z.number().int().nonnegative(),
  uncertainPayments: z.number().int().nonnegative(),
  uncertainRefunds: z.number().int().nonnegative(),
  openIncidents: z.number().int().nonnegative(),
});
