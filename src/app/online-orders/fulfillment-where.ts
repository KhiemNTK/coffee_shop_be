import { OnlineOrderStatus, Prisma, ServeStatus } from '@prisma/client';
import { ONLINE_ORDER_NO_SHOW_GRACE_MS } from '../../common/consts/online-order-settings';

export function fulfillmentWhere(
  overdueAsOf?: Date,
): Prisma.OnlineOrderRequestWhereInput {
  const overdueBefore = overdueAsOf
    ? new Date(overdueAsOf.getTime() - ONLINE_ORDER_NO_SHOW_GRACE_MS)
    : undefined;
  return {
    status: OnlineOrderStatus.ACCEPTED,
    ...(overdueBefore
      ? {
          OR: [
            { pickupAt: { lt: overdueBefore } },
            {
              pickupAt: null,
              orderSession: {
                is: {
                  orderItems: {
                    some: {
                      replacementRemake: { is: null },
                      serveStatus: ServeStatus.READY,
                    },
                    // ASAP pickup becomes overdue only after every unpaid item has been ready for the grace window.
                    none: {
                      replacementRemake: { is: null },
                      serveStatus: { not: ServeStatus.CANCELLED },
                      OR: [
                        { serveStatus: { not: ServeStatus.READY } },
                        { readyAt: null },
                        { readyAt: { gt: overdueBefore } },
                        { isPaid: true },
                        { invoiceId: { not: null } },
                      ],
                    },
                  },
                },
              },
            },
          ],
        }
      : {}),
    orderSession: {
      is: {
        orderItems: {
          some: {
            replacementRemake: { is: null },
            serveStatus: {
              in: [ServeStatus.PENDING, ServeStatus.COOKING, ServeStatus.READY],
            },
          },
        },
      },
    },
  };
}
