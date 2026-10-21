import type { Prisma } from '@prisma/client';

// Shared allowlist for customer-visible feedback; never include staff resolution notes.
export const PUBLIC_TAKEAWAY_FEEDBACK_SELECT = {
  id: true,
  rating: true,
  comment: true,
  createdAt: true,
  resolvedAt: true,
  customerReply: true,
} satisfies Prisma.TakeawayFeedbackSelect;
