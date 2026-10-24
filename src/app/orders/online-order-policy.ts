import { ConflictException } from '@nestjs/common';

export function assertPosOrderMutationAllowed(
  onlineOrderRequest: { id: string } | null | undefined,
) {
  if (onlineOrderRequest)
    throw new ConflictException({
      code: 'ONLINE_ORDER_PICKUP_REQUIRED',
      message: 'Manage this online order through online order management.',
    });
}
