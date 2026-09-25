import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  Sse,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { PermissionKeys } from '../../common/consts/permission-keys';
import { Employee } from '../../common/decorators/employee.decorator';
import { IDDto } from '../../common/dto/param.dto';
import { RequirePermissions } from '../authorization/authorization.decorator';
import {
  CreateKitchenStationDto,
  GetKitchenStationsDto,
  GetKitchenTicketsDto,
  UpdateKitchenStationDto,
} from './dto';
import { KitchenRealtimeService } from './kitchen-realtime.service';
import { KitchenService } from './kitchen.service';

@ApiTags('kitchen')
@Controller('kitchen')
export class KitchenController {
  constructor(
    private readonly kitchen: KitchenService,
    private readonly realtime: KitchenRealtimeService,
  ) {}

  @Post('stations')
  @RequirePermissions(PermissionKeys.KITCHEN_STATIONS_MANAGE)
  createStation(
    @Employee('employeeId') employeeId: string,
    @Body() dto: CreateKitchenStationDto,
  ) {
    return this.kitchen.createStation(employeeId, dto);
  }

  @Get('stations')
  @RequirePermissions(PermissionKeys.KITCHEN_STATIONS_READ)
  getStations(@Query() query: GetKitchenStationsDto) {
    return this.kitchen.getStations(query);
  }

  @Get('stations/:id')
  @RequirePermissions(PermissionKeys.KITCHEN_STATIONS_READ)
  getStation(@Param() { id }: IDDto) {
    return this.kitchen.getStation(id);
  }

  @Patch('stations/:id')
  @RequirePermissions(PermissionKeys.KITCHEN_STATIONS_MANAGE)
  updateStation(
    @Param() { id }: IDDto,
    @Employee('employeeId') employeeId: string,
    @Body() dto: UpdateKitchenStationDto,
  ) {
    return this.kitchen.updateStation(id, employeeId, dto);
  }

  @Delete('stations/:id')
  @RequirePermissions(PermissionKeys.KITCHEN_STATIONS_MANAGE)
  deleteStation(
    @Param() { id }: IDDto,
    @Employee('employeeId') employeeId: string,
  ) {
    return this.kitchen.deleteStation(id, employeeId);
  }

  @Sse('events')
  @RequirePermissions(PermissionKeys.KITCHEN_TICKETS_READ)
  events() {
    return this.realtime.stream();
  }

  @Get('tickets')
  @RequirePermissions(PermissionKeys.KITCHEN_TICKETS_READ)
  getTickets(@Query() query: GetKitchenTicketsDto) {
    return this.kitchen.getTickets(query);
  }

  @Get('tickets/:id')
  @RequirePermissions(PermissionKeys.KITCHEN_TICKETS_READ)
  getTicket(@Param() { id }: IDDto) {
    return this.kitchen.getTicket(id);
  }
}
