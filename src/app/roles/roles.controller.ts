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
import {
  Employee,
  type EmployeeInfo,
} from '../../common/decorators/employee.decorator';

@ApiTags('roles')
@Controller('roles')
export class RolesController {
  constructor(private readonly rolesService: RolesService) {}

  @Post()
  createRole(@Body() createRoleDto: CreateRoleDto) {
    return this.rolesService.createRole(createRoleDto);
  }

  @Get()
  getRoles(@Query() query: GetRolesPaginationDto) {
    return this.rolesService.getRoles(query);
  }

  @Get(':id')
  getRoleById(@Param() { id }: IDDto) {
    return this.rolesService.getRoleById(id);
  }

  @Patch(':id')
  updateRole(@Param() { id }: IDDto, @Body() updateRoleDto: UpdateRoleDto) {
    return this.rolesService.updateRole(id, updateRoleDto);
  }

  @Delete(':id')
  deleteRole(@Param() { id }: IDDto) {
    return this.rolesService.deleteRole(id);
  }

  @Post('export')
  @ExportExcel()
  exportRoles(@Query() exportRolesDto: ExportRolesDto) {
    return this.rolesService.exportRoles(exportRolesDto);
  }

  @Post('import')
  @ImportExcel()
  importRoles(
    @UploadedFile() file: Express.Multer.File,
    @Employee() employee: EmployeeInfo,
  ) {
    return this.rolesService.importRoles({ file, employee });
  }
}
