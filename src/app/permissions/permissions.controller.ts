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
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { PermissionKeys } from '../../common/consts/permission-keys';
import { IDDto } from '../../common/dto/param.dto';
import { RequirePermissions } from '../authorization/authorization.decorator';
import {
  CreatePermissionDto,
  GetPermissionsPaginationDto,
  UpdatePermissionDto,
} from './dto';
import { PermissionsService } from './permissions.service';

@ApiTags('Permissions')
@Controller('permissions')
export class PermissionsController {
  constructor(private readonly permissionsService: PermissionsService) {}

  @Post()
  @ApiOperation({
    deprecated: true,
    summary:
      'Legacy custom permission creation; system keys are deployment-managed',
  })
  @RequirePermissions(PermissionKeys.PERMISSIONS_CREATE)
  createPermission(@Body() createPermissionDto: CreatePermissionDto) {
    return this.permissionsService.createPermission(createPermissionDto);
  }

  @Get()
  @RequirePermissions(PermissionKeys.PERMISSIONS_READ)
  getPermissions(@Query() query: GetPermissionsPaginationDto) {
    return this.permissionsService.getPermissions(query);
  }

  @Get(':id')
  @RequirePermissions(PermissionKeys.PERMISSIONS_READ)
  getPermissionById(@Param() { id }: IDDto) {
    return this.permissionsService.getPermissionById(id);
  }

  @Patch(':id')
  @ApiOperation({
    deprecated: true,
    summary:
      'Legacy custom permission update; system keys are deployment-managed',
  })
  @RequirePermissions(PermissionKeys.PERMISSIONS_UPDATE)
  updatePermission(
    @Param() { id }: IDDto,
    @Body() updatePermissionDto: UpdatePermissionDto,
  ) {
    return this.permissionsService.updatePermission(id, updatePermissionDto);
  }

  @Delete(':id')
  @ApiOperation({
    deprecated: true,
    summary:
      'Legacy custom permission deletion; system keys are deployment-managed',
  })
  @RequirePermissions(PermissionKeys.PERMISSIONS_DELETE)
  deletePermission(@Param() { id }: IDDto) {
    return this.permissionsService.deletePermission(id);
  }
}
