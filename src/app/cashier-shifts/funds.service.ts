import {
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { Prisma, ShiftStatus } from '@prisma/client';
import {
  PRISMA_SERVICE_TOKEN,
  type ExtendedPrismaClient,
} from '../../common/prisma/prisma.service';
import type { ExtendedPrismaTransactionClient } from '../../common/types';
import { PaginationUtilService } from '../../common/utils/pagination-util/pagination-util.service';
import { CreateFundDto, GetFundsDto, UpdateFundDto } from './dto';

@Injectable()
export class FundsService {
  constructor(
    @Inject(PRISMA_SERVICE_TOKEN)
    private readonly prisma: ExtendedPrismaClient,
    private readonly paginationUtil: PaginationUtilService,
  ) {}

  async create(employeeId: string, dto: CreateFundDto) {
    try {
      return await this.prisma.$transaction(async (tx) => {
        await this.assertActiveEmployee(tx, employeeId);
        const fund = await tx.fund.create({
          data: {
            name: dto.name,
            type: dto.type,
            balance: new Prisma.Decimal(dto.openingBalance),
          },
        });
        await this.log(tx, employeeId, 'FUND_CREATED', {
          fundId: fund.id,
          name: fund.name,
          type: fund.type,
          openingBalance: fund.balance.toString(),
        });
        return fund;
      });
    } catch (error) {
      this.rethrowNameConflict(error);
    }
  }

  async findAll(query: GetFundsDto) {
    const where: Prisma.FundWhereInput = {
      deletedAt: null,
      ...(query.type ? { type: query.type } : {}),
      ...(query.keyword
        ? {
            name: {
              contains: query.keyword,
              mode: Prisma.QueryMode.insensitive,
            },
          }
        : {}),
    };
    const totalItems = await this.prisma.fund.count({ where });
    const paging = this.paginationUtil.paging({ ...query, totalItems });
    const funds = await this.prisma.fund.findMany({
      where,
      skip: paging.skip,
      take: paging.itemPerPage,
      orderBy: [{ type: 'asc' }, { name: 'asc' }, { id: 'asc' }],
      include: {
        _count: { select: { shifts: true, cashTransactions: true } },
      },
    });
    return paging.format(funds);
  }

  async findOne(id: string) {
    const fund = await this.prisma.fund.findFirst({
      where: { id, deletedAt: null },
      include: {
        _count: { select: { shifts: true, cashTransactions: true } },
      },
    });
    if (!fund) throw new NotFoundException(`Fund with ID ${id} not found.`);
    return fund;
  }

  async update(id: string, employeeId: string, dto: UpdateFundDto) {
    try {
      return await this.prisma.$transaction(async (tx) => {
        await this.assertActiveEmployee(tx, employeeId);
        const existing = await tx.fund.findFirst({
          where: { id, deletedAt: null },
        });
        if (!existing) {
          throw new NotFoundException(`Fund with ID ${id} not found.`);
        }
        if (dto.type && dto.type !== existing.type) {
          const openShift = await tx.cashierShift.findFirst({
            where: { fundId: id, status: ShiftStatus.OPEN },
            select: { id: true },
          });
          if (openShift) {
            throw new ConflictException(
              'Cannot change the type of a fund used by an open shift.',
            );
          }
        }

        const fund = await tx.fund.update({ where: { id }, data: dto });
        await this.log(tx, employeeId, 'FUND_UPDATED', {
          fundId: id,
          changes: {
            ...(dto.name !== undefined ? { name: dto.name } : {}),
            ...(dto.type !== undefined ? { type: dto.type } : {}),
          },
        });
        return fund;
      });
    } catch (error) {
      this.rethrowNameConflict(error);
    }
  }

  async remove(id: string, employeeId: string) {
    return this.prisma.$transaction(async (tx) => {
      await this.assertActiveEmployee(tx, employeeId);
      const fund = await tx.fund.findFirst({
        where: { id, deletedAt: null },
        select: { id: true, balance: true },
      });
      if (!fund) throw new NotFoundException(`Fund with ID ${id} not found.`);
      if (!fund.balance.isZero()) {
        throw new ConflictException('A non-empty fund cannot be deleted.');
      }
      const openShift = await tx.cashierShift.findFirst({
        where: { fundId: id, status: ShiftStatus.OPEN },
        select: { id: true },
      });
      if (openShift) {
        throw new ConflictException(
          'A fund with an open shift cannot be deleted.',
        );
      }

      await tx.fund.update({ where: { id }, data: { deletedAt: new Date() } });
      await this.log(tx, employeeId, 'FUND_DELETED', { fundId: id });
      return { success: true, id };
    });
  }

  private async assertActiveEmployee(
    tx: ExtendedPrismaTransactionClient,
    employeeId: string,
  ) {
    const employee = await tx.employee.findFirst({
      where: { id: employeeId, isActive: true, deletedAt: null },
      select: { id: true },
    });
    if (!employee) {
      throw new UnauthorizedException('Employee is inactive or not found.');
    }
  }

  private async log(
    tx: ExtendedPrismaTransactionClient,
    employeeId: string,
    actionType: string,
    details: Prisma.InputJsonObject,
  ) {
    await tx.actionLog.create({ data: { employeeId, actionType, details } });
  }

  private rethrowNameConflict(error: unknown): never {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === 'P2002'
    ) {
      throw new ConflictException('An active fund with this name exists.');
    }
    throw error;
  }
}
