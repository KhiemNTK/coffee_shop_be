import { NotFoundException } from '@nestjs/common';
import { SYSTEM_ERRORS } from '../consts/message';
import type { ExtendedPrismaTransactionClient } from '../types';

// Call inside a serializable transaction, including employee assignment writes.
export async function assertActivePosition(
  tx: ExtendedPrismaTransactionClient,
  id: string,
) {
  const position = await tx.position.findFirst({
    where: { id, deletedAt: null },
  });
  if (!position) throw new NotFoundException(SYSTEM_ERRORS.POSITION_NOT_FOUND);
  return position;
}
