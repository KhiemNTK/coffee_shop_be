import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { PermissionKeys } from '../../common/consts/permission-keys';
import { Employee } from '../../common/decorators/employee.decorator';
import { IDDto } from '../../common/dto/param.dto';
import { RequirePermissions } from '../authorization/authorization.decorator';
import {
  CreateMenuCategoryDto,
  CreateMenuItemDto,
  GetMenuCategoriesDto,
  GetMenuItemsDto,
  ReplaceMenuRecipeDto,
  UpdateMenuCategoryDto,
  UpdateMenuItemAvailabilityDto,
  UpdateMenuItemDto,
} from './dto';
import { MenuService } from './menu.service';

@ApiTags('menu')
@Controller('menu')
export class MenuController {
  constructor(private readonly menuService: MenuService) {}

  @Post('categories')
  @RequirePermissions(PermissionKeys.MENU_CREATE)
  createCategory(
    @Employee('employeeId') employeeId: string,
    @Body() dto: CreateMenuCategoryDto,
  ) {
    return this.menuService.createCategory(employeeId, dto);
  }

  @Get('categories')
  @RequirePermissions(PermissionKeys.MENU_READ)
  getCategories(@Query() query: GetMenuCategoriesDto) {
    return this.menuService.getCategories(query);
  }

  @Get('categories/:id')
  @RequirePermissions(PermissionKeys.MENU_READ)
  getCategoryById(@Param() { id }: IDDto) {
    return this.menuService.getCategoryById(id);
  }

  @Patch('categories/:id')
  @RequirePermissions(PermissionKeys.MENU_UPDATE)
  updateCategory(
    @Param() { id }: IDDto,
    @Employee('employeeId') employeeId: string,
    @Body() dto: UpdateMenuCategoryDto,
  ) {
    return this.menuService.updateCategory(id, employeeId, dto);
  }

  @Delete('categories/:id')
  @RequirePermissions(PermissionKeys.MENU_DELETE)
  deleteCategory(
    @Param() { id }: IDDto,
    @Employee('employeeId') employeeId: string,
  ) {
    return this.menuService.deleteCategory(id, employeeId);
  }

  @Post('items')
  @RequirePermissions(PermissionKeys.MENU_CREATE)
  createItem(
    @Employee('employeeId') employeeId: string,
    @Body() dto: CreateMenuItemDto,
  ) {
    return this.menuService.createItem(employeeId, dto);
  }

  @Get('items')
  @RequirePermissions(PermissionKeys.MENU_READ)
  getItems(@Query() query: GetMenuItemsDto) {
    return this.menuService.getItems(query);
  }

  @Get('items/:id')
  @RequirePermissions(PermissionKeys.MENU_READ)
  getItemById(@Param() { id }: IDDto) {
    return this.menuService.getItemById(id);
  }

  @Patch('items/:id')
  @RequirePermissions(PermissionKeys.MENU_UPDATE)
  updateItem(
    @Param() { id }: IDDto,
    @Employee('employeeId') employeeId: string,
    @Body() dto: UpdateMenuItemDto,
  ) {
    return this.menuService.updateItem(id, employeeId, dto);
  }

  @Patch('items/:id/availability')
  @RequirePermissions(PermissionKeys.MENU_UPDATE)
  updateItemAvailability(
    @Param() { id }: IDDto,
    @Employee('employeeId') employeeId: string,
    @Body() dto: UpdateMenuItemAvailabilityDto,
  ) {
    return this.menuService.updateItemAvailability(id, employeeId, dto);
  }

  @Get('items/:id/recipe')
  @RequirePermissions(PermissionKeys.MENU_READ)
  getItemRecipe(@Param() { id }: IDDto) {
    return this.menuService.getItemRecipe(id);
  }

  @Put('items/:id/recipe')
  @RequirePermissions(PermissionKeys.MENU_UPDATE)
  replaceItemRecipe(
    @Param() { id }: IDDto,
    @Employee('employeeId') employeeId: string,
    @Body() dto: ReplaceMenuRecipeDto,
  ) {
    return this.menuService.replaceItemRecipe(id, employeeId, dto);
  }

  @Delete('items/:id')
  @RequirePermissions(PermissionKeys.MENU_DELETE)
  deleteItem(
    @Param() { id }: IDDto,
    @Employee('employeeId') employeeId: string,
  ) {
    return this.menuService.deleteItem(id, employeeId);
  }
}
