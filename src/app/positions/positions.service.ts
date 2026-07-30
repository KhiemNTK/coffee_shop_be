import { Injectable, Inject, NotFoundException } from '@nestjs/common';
import { CreatePositionDto } from './dto/create-position.dto';
import { UpdatePositionDto } from './dto/update-position.dto';
import { GetPositionsPaginationDto } from './dto/get-position.dto';
import { PaginationUtilService } from '../../common/utils/pagination-util/pagination-util.service';
import type { ExtendedPrismaClient } from '../../common/prisma/prisma.service';
import { PRISMA_SERVICE_TOKEN } from '../../common/prisma/prisma.service';
import { Position } from '../../generated/zod';
import { QueryUtilService } from '../../common/utils/query-util/query-util.service';
import { SYSTEM_ERRORS } from '../../common/consts/message';

@Injectable()
export class PositionsService {
  constructor(
    @Inject(PRISMA_SERVICE_TOKEN)
    private readonly prisma: ExtendedPrismaClient,
    private paginationUtilService: PaginationUtilService,
    private queryUtilService: QueryUtilService,
  ) {}

  async createPosition(createPositionDto: CreatePositionDto) {
    return this.prisma.position.create({
      data: createPositionDto,
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
      this.queryUtilService.convertFieldsSelectOption<Position>(select);
    const searchQuery = this.queryUtilService.buildSearchQuery<Position>({
      search,
    });
    const list = await this.prisma.position.findMany({
      select: fieldsSelect,
      skip: paging.skip,
      take: paging.itemPerPage,
      where: searchQuery,
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

  async updatePosition(id: string, updatePositionDto: UpdatePositionDto) {
    await this.getPositionById(id);

    return this.prisma.position.update({
      where: { id },
      data: updatePositionDto,
    });
  }

  async deletePosition(id: string) {
    await this.getPositionById(id);

    await this.prisma.position.delete({
      where: { id },
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
