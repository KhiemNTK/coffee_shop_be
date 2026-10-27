import {
  Injectable,
  Inject,
  NotFoundException,
  ConflictException,
} from '@nestjs/common';
import type { Position } from '@prisma/client';
import {
  CreatePositionDto,
  GetPositionsPaginationDto,
  UpdatePositionDto,
} from './dto';
import { PaginationUtilService } from '../../common/utils/pagination-util/pagination-util.service';
import {
  type ExtendedPrismaClient,
  PRISMA_SERVICE_TOKEN,
} from '../../common/prisma/prisma.service';
import { QueryUtilService } from '../../common/utils/query-util/query-util.service';
import { SYSTEM_ERRORS } from '../../common/consts/message';
import { assertActiveEmployee } from '../../common/prisma/employee.util';
import { assertActivePosition } from '../../common/prisma/position.util';
import { runSerializableTransaction } from '../../common/prisma/transaction.util';

@Injectable()
export class PositionsService {
  constructor(
    @Inject(PRISMA_SERVICE_TOKEN)
    private readonly prisma: ExtendedPrismaClient,
    private paginationUtilService: PaginationUtilService,
    private queryUtilService: QueryUtilService,
  ) {}

  async createPosition(
    createPositionDto: CreatePositionDto,
    employeeId: string,
  ) {
    return runSerializableTransaction(this.prisma, async (tx) => {
      await assertActiveEmployee(tx, employeeId);
      const position = await tx.position.create({ data: createPositionDto });
      await tx.actionLog.create({
        data: {
          employeeId,
          actionType: 'POSITION_CREATED',
          details: {
            positionId: position.id,
            after: { name: position.name, salary: position.salary.toString() },
          },
        },
      });
      return position;
    });
  }

  async getPositions({
    page,
    itemPerPage,
    select,
    ...search
  }: GetPositionsPaginationDto) {
    const totalItems = await this.prisma.position.count();
    const paging = this.paginationUtilService.paging({
      page,
      itemPerPage,
      totalItems,
    });
    const fieldsSelect =
      this.queryUtilService.convertFieldsSelectOption<Position>(
        select,
        'Position',
      );
    const searchQuery = this.queryUtilService.buildSearchQuery<Position>({
      search,
    });
    const list = await this.prisma.position.findMany({
      select: fieldsSelect,
      skip: paging.skip,
      take: paging.itemPerPage,
      where: searchQuery,
      orderBy: [{ name: 'asc' }, { id: 'asc' }],
    });

    const data = paging.format(list);
    return data;
  }

  async getPositionById(id: string) {
    const position = await this.prisma.position.findUnique({
      where: { id },
    });

    if (!position) {
      throw new NotFoundException(SYSTEM_ERRORS.POSITION_NOT_FOUND);
    }

    return position;
  }

  async updatePosition(
    id: string,
    updatePositionDto: UpdatePositionDto,
    employeeId: string,
  ) {
    return runSerializableTransaction(this.prisma, async (tx) => {
      await assertActiveEmployee(tx, employeeId);
      const before = await assertActivePosition(tx, id);
      const position = await tx.position.update({
        where: { id, deletedAt: null },
        data: updatePositionDto,
      });
      await tx.actionLog.create({
        data: {
          employeeId,
          actionType: 'POSITION_UPDATED',
          details: {
            positionId: id,
            before: { name: before.name, salary: before.salary.toString() },
            after: { name: position.name, salary: position.salary.toString() },
          },
        },
      });
      return position;
    });
  }

  async deletePosition(id: string, employeeId: string) {
    await runSerializableTransaction(this.prisma, async (tx) => {
      await assertActiveEmployee(tx, employeeId);
      const before = await assertActivePosition(tx, id);
      const assigned = await tx.employee.count({
        where: { positionId: id, deletedAt: null },
      });
      if (assigned > 0) {
        throw new ConflictException({
          code: 'POSITION_IN_USE',
          message: 'Reassign employees before deleting this position.',
          details: { employeeCount: assigned },
        });
      }
      await tx.position.update({
        where: { id, deletedAt: null },
        data: { deletedAt: new Date() },
      });
      await tx.actionLog.create({
        data: {
          employeeId,
          actionType: 'POSITION_DELETED',
          details: {
            positionId: id,
            before: { name: before.name, salary: before.salary.toString() },
          },
        },
      });
    });

    return {
      success: true,
      message: `Position #${id} has been deleted successfully`,
    };
  }

  async getPositionsForDropdown() {
    return this.prisma.position.findMany({
      select: {
        id: true,
        name: true,
      },
      orderBy: {
        name: 'asc',
      },
    });
  }
}
