import type { OnlineOrderRequest } from '@prisma/client';

export const ONLINE_ORDER_ACCESS_WINDOW_MS = 72 * 60 * 60 * 1000;
export const PICKUP_ACCESS_GRACE_MS = 24 * 60 * 60 * 1000;

export function onlineOrderAccessExpiresAt(
  request: Pick<OnlineOrderRequest, 'createdAt' | 'pickupAt'>,
): Date {
  return new Date(
    Math.max(
      request.createdAt.getTime() + ONLINE_ORDER_ACCESS_WINDOW_MS,
      request.pickupAt
        ? request.pickupAt.getTime() + PICKUP_ACCESS_GRACE_MS
        : 0,
    ),
  );
}
