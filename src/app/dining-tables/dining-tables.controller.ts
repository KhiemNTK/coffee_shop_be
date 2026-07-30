import {
  Controller,
  Get,
  Post,
  Body,
  Patch,
  Param,
  Delete,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { DiningTablesService } from './dining-tables.service';
import {
  CreateDiningTableDto,
  UpdateDiningTableDto,
} from './dto/create-dining-table.dto';
import { IDDto } from '../../common/dto/param.dto';
import { OrdersService } from '../orders/orders.service';

@ApiTags('Dining Tables')
@Controller('dining-tables')
export class DiningTablesController {
  constructor(
    private readonly diningTablesService: DiningTablesService,
    private readonly ordersService: OrdersService,
  ) {}

  @Post()
  createTable(@Body() createDiningTableDto: CreateDiningTableDto) {
    return this.diningTablesService.createTable(createDiningTableDto);
  }

  @Get()
  getTables() {
    return this.diningTablesService.getTables();
  }

  @Patch(':id')
  updateTable(
    @Param() { id }: IDDto,
    @Body() updateDiningTableDto: UpdateDiningTableDto,
  ) {
    return this.diningTablesService.updateTable(id, updateDiningTableDto);
  }

  @Delete(':id')
  deleteTable(@Param() { id }: IDDto) {
    return this.diningTablesService.deleteTable(id);
  }
}
