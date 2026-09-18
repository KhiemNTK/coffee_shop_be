import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { PermissionKeys } from '../../common/consts/permission-keys';
import { Employee } from '../../common/decorators/employee.decorator';
import { IDDto } from '../../common/dto/param.dto';
import { RequirePermissions } from '../authorization/authorization.decorator';
import {
  CreateEquipmentDto,
  GetEquipmentDto,
  GetEquipmentEventsDto,
  TransitionEquipmentDto,
  UpdateEquipmentDto,
} from './dto';
import { EquipmentService } from './equipment.service';

@Controller('equipment')
export class EquipmentController {
  constructor(private readonly equipmentService: EquipmentService) {}

  @Post()
  @RequirePermissions(PermissionKeys.EQUIPMENT_CREATE)
  create(
    @Employee('employeeId') employeeId: string,
    @Body() dto: CreateEquipmentDto,
  ) {
    return this.equipmentService.create(employeeId, dto);
  }

  @Get()
  @RequirePermissions(PermissionKeys.EQUIPMENT_READ)
  findAll(@Query() query: GetEquipmentDto) {
    return this.equipmentService.findAll(query);
  }

  @Get(':id')
  @RequirePermissions(PermissionKeys.EQUIPMENT_READ)
  findOne(@Param() { id }: IDDto) {
    return this.equipmentService.findOne(id);
  }

  @Get(':id/events')
  @RequirePermissions(PermissionKeys.EQUIPMENT_READ)
  findEvents(@Param() { id }: IDDto, @Query() query: GetEquipmentEventsDto) {
    return this.equipmentService.findEvents(id, query);
  }

  @Patch(':id')
  @RequirePermissions(PermissionKeys.EQUIPMENT_UPDATE)
  update(
    @Param() { id }: IDDto,
    @Employee('employeeId') employeeId: string,
    @Body() dto: UpdateEquipmentDto,
  ) {
    return this.equipmentService.update(id, employeeId, dto);
  }

  @Post(':id/transitions')
  @RequirePermissions(PermissionKeys.EQUIPMENT_TRANSITION)
  transition(
    @Param() { id }: IDDto,
    @Employee('employeeId') employeeId: string,
    @Body() dto: TransitionEquipmentDto,
  ) {
    return this.equipmentService.transition(id, employeeId, dto);
  }
}
