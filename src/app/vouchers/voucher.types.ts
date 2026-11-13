import type { Decimal } from '@prisma/client/runtime/library';
import type { z } from 'zod';
import type { VoucherWalletStatusSchema } from './dto/voucher.dto';

export interface VoucherQuoteInput {
  customerId: string;
  voucherId: string;
  subTotal: string | Decimal;
}

export type VoucherWalletStatus = z.infer<typeof VoucherWalletStatusSchema>;
