import {
  Controller,
  Get,
  Post,
  Body,
  Patch,
  Param,
  Delete,
} from '@nestjs/common';
import { EquipmentService } from './equipment.service';
import { CreateEquipmentDto } from './dto/create-equipment.dto';
import { UpdateEquipmentDto } from './dto/update-equipment.dto';
import { PermissionKeys } from '../../common/consts/permission-keys';
import { RequirePermissions } from '../authorization/authorization.decorator';

@Controller('equipment')
export class EquipmentController {
  constructor(private readonly equipmentService: EquipmentService) {}

  @Post()
  @RequirePermissions(PermissionKeys.EQUIPMENT_CREATE)
  create(@Body() createEquipmentDto: CreateEquipmentDto) {
    return this.equipmentService.create(createEquipmentDto);
  }

  @Get()
  @RequirePermissions(PermissionKeys.EQUIPMENT_READ)
  findAll() {
    return this.equipmentService.findAll();
  }

  @Get(':id')
  @RequirePermissions(PermissionKeys.EQUIPMENT_READ)
  findOne(@Param('id') id: string) {
    return this.equipmentService.findOne(+id);
  }

  @Patch(':id')
  @RequirePermissions(PermissionKeys.EQUIPMENT_UPDATE)
  update(
    @Param('id') id: string,
    @Body() updateEquipmentDto: UpdateEquipmentDto,
  ) {
    return this.equipmentService.update(+id, updateEquipmentDto);
  }

  @Delete(':id')
  @RequirePermissions(PermissionKeys.EQUIPMENT_DELETE)
  remove(@Param('id') id: string) {
    return this.equipmentService.remove(+id);
  }
}
