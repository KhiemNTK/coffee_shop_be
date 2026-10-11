import { Prisma } from '@prisma/client';

// Cash refunds have no remote provider attempt; consumers share the same receipt projection.
export const INVOICE_REFUNDS_SQL = Prisma.sql`
  SELECT pr."id", pa."invoiceId", pr."amount", pr."status"::text AS "status", pr."completedAt"
  FROM "PaymentRefund" pr
  JOIN "PaymentAttempt" pa ON pa."id" = pr."paymentAttemptId"
  UNION ALL
  SELECT cr."id", cr."invoiceId", cr."amount", 'SUCCEEDED'::text AS "status", cr."completedAt"
  FROM "CashRefund" cr
`;
