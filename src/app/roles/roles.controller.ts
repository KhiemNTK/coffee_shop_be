import {
  Controller,
  Get,
  Post,
  Body,
  Patch,
  Param,
  Delete,
  Query,
  UploadedFile,
  Put,
} from '@nestjs/common';
import { RolesService } from './roles.service';
import { CreateRoleDto } from './dto/create-role.dto';
import { UpdateRoleDto } from './dto/update-role.dto';
import { ApiTags } from '@nestjs/swagger';
import { IDDto } from '../../common/dto/param.dto';
import { ExportRolesDto, GetRolesPaginationDto } from './dto/get-role.dto';
import {
  ExportExcel,
  ImportExcel,
} from '../../common/utils/excel-util/excel-util.decorator';
import { Employee } from '../../common/decorators/employee.decorator';
import type { EmployeeInfo } from '../../common/types';
import { PermissionKeys } from '../../common/consts/permission-keys';
import { RequirePermissions } from '../authorization/authorization.decorator';
import { ReplaceRolePermissionsDto } from './dto/role-permissions.dto';

@ApiTags('roles')
@Controller('roles')
export class RolesController {
  constructor(private readonly rolesService: RolesService) {}

  @Post()
  @RequirePermissions(PermissionKeys.ROLES_CREATE)
  createRole(@Body() createRoleDto: CreateRoleDto) {
    return this.rolesService.createRole(createRoleDto);
  }

  @Get()
  @RequirePermissions(PermissionKeys.ROLES_READ)
  getRoles(@Query() query: GetRolesPaginationDto) {
    return this.rolesService.getRoles(query);
  }

  @Post('export')
  @RequirePermissions(PermissionKeys.ROLES_READ)
  @ExportExcel()
  exportRoles(@Query() exportRolesDto: ExportRolesDto) {
    return this.rolesService.exportRoles(exportRolesDto);
  }

  @Post('import')
  @RequirePermissions(PermissionKeys.ROLES_CREATE)
  @ImportExcel()
  importRoles(
    @UploadedFile() file: Express.Multer.File,
    @Employee() employee: EmployeeInfo,
  ) {
    return this.rolesService.importRoles({ file, employee });
  }

  @Get(':id/permissions')
  @RequirePermissions(PermissionKeys.ROLE_PERMISSIONS_READ)
  getRolePermissions(@Param() { id }: IDDto) {
    return this.rolesService.getRolePermissions(id);
  }

  @Put(':id/permissions')
  @RequirePermissions(PermissionKeys.ROLE_PERMISSIONS_UPDATE)
  replaceRolePermissions(
    @Param() { id }: IDDto,
    @Body() replaceRolePermissionsDto: ReplaceRolePermissionsDto,
  ) {
    return this.rolesService.replaceRolePermissions(
      id,
      replaceRolePermissionsDto,
    );
  }

  @Get(':id')
  @RequirePermissions(PermissionKeys.ROLES_READ)
  getRoleById(@Param() { id }: IDDto) {
    return this.rolesService.getRoleById(id);
  }

  @Patch(':id')
  @RequirePermissions(PermissionKeys.ROLES_UPDATE)
  updateRole(@Param() { id }: IDDto, @Body() updateRoleDto: UpdateRoleDto) {
    return this.rolesService.updateRole(id, updateRoleDto);
  }

  @Delete(':id')
  @RequirePermissions(PermissionKeys.ROLES_DELETE)
  deleteRole(@Param() { id }: IDDto) {
    return this.rolesService.deleteRole(id);
  }
}
