import { UnauthorizedException } from '@nestjs/common';
import type { ExtendedPrismaTransactionClient } from '../types/prisma.types';

export async function assertActiveEmployee(
  client: Pick<ExtendedPrismaTransactionClient, 'employee'>,
  employeeId: string,
): Promise<void> {
  const employee = await client.employee.findFirst({
    where: { id: employeeId, isActive: true, deletedAt: null },
    select: { id: true },
  });
  if (!employee) {
    throw new UnauthorizedException('Employee is inactive or not found.');
  }
}
