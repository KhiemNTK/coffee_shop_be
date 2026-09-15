import {
  Controller,
  Get,
  Post,
  Body,
  Patch,
  Param,
  Delete,
} from '@nestjs/common';
import { MenuService } from './menu.service';
import { CreateMenuDto } from './dto/create-menu.dto';
import { UpdateMenuDto } from './dto/update-menu.dto';
import { PermissionKeys } from '../../common/consts/permission-keys';
import { RequirePermissions } from '../authorization/authorization.decorator';

@Controller('menu')
export class MenuController {
  constructor(private readonly menuService: MenuService) {}

  @Post()
  @RequirePermissions(PermissionKeys.MENU_CREATE)
  create(@Body() createMenuDto: CreateMenuDto) {
    return this.menuService.create(createMenuDto);
  }

  @Get()
  @RequirePermissions(PermissionKeys.MENU_READ)
  findAll() {
    return this.menuService.findAll();
  }

  @Get(':id')
  @RequirePermissions(PermissionKeys.MENU_READ)
  findOne(@Param('id') id: string) {
    return this.menuService.findOne(+id);
  }

  @Patch(':id')
  @RequirePermissions(PermissionKeys.MENU_UPDATE)
  update(@Param('id') id: string, @Body() updateMenuDto: UpdateMenuDto) {
    return this.menuService.update(+id, updateMenuDto);
  }

  @Delete(':id')
  @RequirePermissions(PermissionKeys.MENU_DELETE)
  remove(@Param('id') id: string) {
    return this.menuService.remove(+id);
  }
}
