import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { PermissionKeys } from '../../common/consts/permission-keys';
import { Employee } from '../../common/decorators/employee.decorator';
import { RequirePermissions } from '../authorization/authorization.decorator';
import {
  CreateSystemSettingDto,
  DeleteSystemSettingDto,
  GetSystemSettingRevisionsDto,
  GetSystemSettingsDto,
  SystemSettingKeyDto,
  UpdateSystemSettingDto,
} from './dto';
import { SystemSettingsService } from './system-settings.service';

@Controller('system-settings')
export class SystemSettingsController {
  constructor(private readonly systemSettingsService: SystemSettingsService) {}

  @Post()
  @RequirePermissions(PermissionKeys.SYSTEM_SETTINGS_CREATE)
  create(
    @Employee('employeeId') employeeId: string,
    @Body() dto: CreateSystemSettingDto,
  ) {
    return this.systemSettingsService.create(employeeId, dto);
  }

  @Get()
  @RequirePermissions(PermissionKeys.SYSTEM_SETTINGS_READ)
  findAll(@Query() query: GetSystemSettingsDto) {
    return this.systemSettingsService.findAll(query);
  }

  @Get(':key')
  @RequirePermissions(PermissionKeys.SYSTEM_SETTINGS_READ)
  findOne(@Param() { key }: SystemSettingKeyDto) {
    return this.systemSettingsService.findOne(key);
  }

  @Get(':key/revisions')
  @RequirePermissions(PermissionKeys.SYSTEM_SETTINGS_READ)
  findRevisions(
    @Param() { key }: SystemSettingKeyDto,
    @Query() query: GetSystemSettingRevisionsDto,
  ) {
    return this.systemSettingsService.findRevisions(key, query);
  }

  @Patch(':key')
  @RequirePermissions(PermissionKeys.SYSTEM_SETTINGS_UPDATE)
  update(
    @Param() { key }: SystemSettingKeyDto,
    @Employee('employeeId') employeeId: string,
    @Body() dto: UpdateSystemSettingDto,
  ) {
    return this.systemSettingsService.update(key, employeeId, dto);
  }

  @Delete(':key')
  @RequirePermissions(PermissionKeys.SYSTEM_SETTINGS_DELETE)
  remove(
    @Param() { key }: SystemSettingKeyDto,
    @Employee('employeeId') employeeId: string,
    @Query() query: DeleteSystemSettingDto,
  ) {
    return this.systemSettingsService.remove(
      key,
      employeeId,
      query.expectedVersion,
    );
  }
}
