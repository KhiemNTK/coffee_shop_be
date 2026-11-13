export type VoucherDiscountSnapshot = {
  voucherId: string;
  campaignId: string;
  name: string;
  discountType: 'PERCENTAGE' | 'FIXED_AMOUNT';
  discountValue: string;
  maxDiscount: string | null;
  minSubtotal: string;
  startDate: string;
  endDate: string;
  discountAmount: string;
  totalAmount: string;
};

export type CustomerOrderVoucherInput = {
  voucherId?: string;
  expectedTotal?: string;
  quoteFingerprint?: string;
};
