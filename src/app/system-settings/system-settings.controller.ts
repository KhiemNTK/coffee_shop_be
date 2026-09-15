import {
  Controller,
  Get,
  Post,
  Body,
  Patch,
  Param,
  Delete,
} from '@nestjs/common';
import { SystemSettingsService } from './system-settings.service';
import { CreateSystemSettingDto } from './dto/create-system-setting.dto';
import { UpdateSystemSettingDto } from './dto/update-system-setting.dto';
import { PermissionKeys } from '../../common/consts/permission-keys';
import { RequirePermissions } from '../authorization/authorization.decorator';

@Controller('system-settings')
export class SystemSettingsController {
  constructor(private readonly systemSettingsService: SystemSettingsService) {}

  @Post()
  @RequirePermissions(PermissionKeys.SYSTEM_SETTINGS_CREATE)
  create(@Body() createSystemSettingDto: CreateSystemSettingDto) {
    return this.systemSettingsService.create(createSystemSettingDto);
  }

  @Get()
  @RequirePermissions(PermissionKeys.SYSTEM_SETTINGS_READ)
  findAll() {
    return this.systemSettingsService.findAll();
  }

  @Get(':id')
  @RequirePermissions(PermissionKeys.SYSTEM_SETTINGS_READ)
  findOne(@Param('id') id: string) {
    return this.systemSettingsService.findOne(+id);
  }

  @Patch(':id')
  @RequirePermissions(PermissionKeys.SYSTEM_SETTINGS_UPDATE)
  update(
    @Param('id') id: string,
    @Body() updateSystemSettingDto: UpdateSystemSettingDto,
  ) {
    return this.systemSettingsService.update(+id, updateSystemSettingDto);
  }

  @Delete(':id')
  @RequirePermissions(PermissionKeys.SYSTEM_SETTINGS_DELETE)
  remove(@Param('id') id: string) {
    return this.systemSettingsService.remove(+id);
  }
}
