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
import { PermissionKeys } from '../../common/consts/permission-keys';
import { RequirePermissions } from '../authorization/authorization.decorator';

@ApiTags('Dining Tables')
@Controller('dining-tables')
export class DiningTablesController {
  constructor(
    private readonly diningTablesService: DiningTablesService,
    private readonly ordersService: OrdersService,
  ) {}

  @Post()
  @RequirePermissions(PermissionKeys.DINING_TABLES_CREATE)
  createTable(@Body() createDiningTableDto: CreateDiningTableDto) {
    return this.diningTablesService.createTable(createDiningTableDto);
  }

  @Get()
  @RequirePermissions(PermissionKeys.DINING_TABLES_READ)
  getTables() {
    return this.diningTablesService.getTables();
  }

  @Patch(':id')
  @RequirePermissions(PermissionKeys.DINING_TABLES_UPDATE)
  updateTable(
    @Param() { id }: IDDto,
    @Body() updateDiningTableDto: UpdateDiningTableDto,
  ) {
    return this.diningTablesService.updateTable(id, updateDiningTableDto);
  }

  @Delete(':id')
  @RequirePermissions(PermissionKeys.DINING_TABLES_DELETE)
  deleteTable(@Param() { id }: IDDto) {
    return this.diningTablesService.deleteTable(id);
  }
}
