import { PaymentAttemptStatus } from '@prisma/client';

export const UNRESOLVED_PAYMENT_ATTEMPT_STATUSES = [
  PaymentAttemptStatus.PENDING,
  PaymentAttemptStatus.EXPIRED,
  PaymentAttemptStatus.REQUIRES_REVIEW,
];
