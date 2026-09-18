import {
  Injectable,
  BadRequestException,
  ConflictException,
  NotFoundException,
  Inject,
  Logger,
} from '@nestjs/common';
import { TableStatus, SessionStatus } from '@prisma/client';
import {
  PRISMA_SERVICE_TOKEN,
  type ExtendedPrismaClient,
} from '../../common/prisma/prisma.service';
import {
  CreateDiningTableDto,
  UpdateDiningTableDto,
} from './dto/create-dining-table.dto';

@Injectable()
export class DiningTablesService {
  private readonly logger = new Logger(DiningTablesService.name);

  constructor(
    @Inject(PRISMA_SERVICE_TOKEN)
    private readonly prisma: ExtendedPrismaClient,
  ) {}

  async createTable(createDto: CreateDiningTableDto) {
    const { name } = createDto;

    const existingTable = await this.prisma.diningTable.findFirst({
      where: {
        deletedAt: null,
        name: { equals: name, mode: 'insensitive' },
      },
    });

    if (existingTable) {
      throw new ConflictException(
        `A dining table with the name '${name}' already exists.`,
      );
    }

    return this.prisma.diningTable.create({
      data: {
        name,
        status: TableStatus.EMPTY,
      },
    });
  }

  async updateTable(id: string, updateDto: UpdateDiningTableDto) {
    const { name } = updateDto;

    const table = await this.prisma.diningTable.findFirst({
      where: { id, deletedAt: null },
    });

    if (!table) {
      throw new NotFoundException(`Dining table with ID ${id} not found.`);
    }

    if (name && name.toLowerCase() !== table.name.toLowerCase()) {
      const duplicateName = await this.prisma.diningTable.findFirst({
        where: {
          id: { not: id },
          deletedAt: null,
          name: { equals: name, mode: 'insensitive' },
        },
      });

      if (duplicateName) {
        throw new ConflictException(
          `A dining table with the name '${name}' already exists.`,
        );
      }
    }

    return this.prisma.diningTable.update({
      where: { id },
      data: {
        name,
      },
    });
  }

  async deleteTable(id: string) {
    const table = await this.prisma.diningTable.findFirst({
      where: { id, deletedAt: null },
    });

    if (!table) {
      throw new NotFoundException(`Dining table with ID ${id} not found.`);
    }

    if (table.status !== TableStatus.EMPTY) {
      throw new BadRequestException(
        `Cannot delete table '${table.name}' because its current status is ${table.status}. Please finalize operations or clear the table first.`,
      );
    }

    await this.prisma.diningTable.update({
      where: { id },
      data: { deletedAt: new Date() },
    });

    this.logger.log(
      `Table '${table.name}' (${id}) has been successfully soft-deleted.`,
    );
    return { success: true, message: 'Table successfully deleted.' };
  }

  async getTables() {
    return this.prisma.diningTable.findMany({
      where: { deletedAt: null },
      include: {
        orderSessions: {
          where: { sessionStatus: SessionStatus.ACTIVE },
          take: 1,
          include: {
            orderItems: true,
          },
        },
      },
      orderBy: { name: 'asc' },
    });
  }
}
