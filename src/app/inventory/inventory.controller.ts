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
import { ApiTags } from '@nestjs/swagger';
import { PermissionKeys } from '../../common/consts/permission-keys';
import { Employee } from '../../common/decorators/employee.decorator';
import { IDDto } from '../../common/dto/param.dto';
import { RequirePermissions } from '../authorization/authorization.decorator';
import {
  BulkInventoryMovementDto,
  GetInventoryTransactionsDto,
  InventoryMovementDto,
} from './dto/inventory-common.dto';
import {
  CreateInventoryCategoryDto,
  GetInventoryCategoriesDto,
  UpdateInventoryCategoryDto,
} from './dto/inventory-category.dto';
import {
  CreateInventoryItemDto,
  GetInventoryItemsDto,
  UpdateInventoryItemDto,
} from './dto/inventory-item.dto';
import { CreateUnitDto, GetUnitsDto, UpdateUnitDto } from './dto/unit.dto';
import { InventoryService } from './inventory.service';

@ApiTags('inventory')
@Controller('inventory')
export class InventoryController {
  constructor(private readonly inventoryService: InventoryService) {}

  @Post('categories')
  @RequirePermissions(PermissionKeys.INVENTORY_CREATE)
  createCategory(
    @Employee('employeeId') employeeId: string,
    @Body() dto: CreateInventoryCategoryDto,
  ) {
    return this.inventoryService.createCategory(employeeId, dto);
  }

  @Get('categories')
  @RequirePermissions(PermissionKeys.INVENTORY_READ)
  getCategories(@Query() query: GetInventoryCategoriesDto) {
    return this.inventoryService.getCategories(query);
  }

  @Get('categories/:id')
  @RequirePermissions(PermissionKeys.INVENTORY_READ)
  getCategoryById(@Param() { id }: IDDto) {
    return this.inventoryService.getCategoryById(id);
  }

  @Patch('categories/:id')
  @RequirePermissions(PermissionKeys.INVENTORY_UPDATE)
  updateCategory(
    @Param() { id }: IDDto,
    @Employee('employeeId') employeeId: string,
    @Body() dto: UpdateInventoryCategoryDto,
  ) {
    return this.inventoryService.updateCategory(id, employeeId, dto);
  }

  @Delete('categories/:id')
  @RequirePermissions(PermissionKeys.INVENTORY_DELETE)
  deleteCategory(
    @Param() { id }: IDDto,
    @Employee('employeeId') employeeId: string,
  ) {
    return this.inventoryService.deleteCategory(id, employeeId);
  }

  @Post('units')
  @RequirePermissions(PermissionKeys.INVENTORY_CREATE)
  createUnit(
    @Employee('employeeId') employeeId: string,
    @Body() dto: CreateUnitDto,
  ) {
    return this.inventoryService.createUnit(employeeId, dto);
  }

  @Get('units')
  @RequirePermissions(PermissionKeys.INVENTORY_READ)
  getUnits(@Query() query: GetUnitsDto) {
    return this.inventoryService.getUnits(query);
  }

  @Get('units/:id')
  @RequirePermissions(PermissionKeys.INVENTORY_READ)
  getUnitById(@Param() { id }: IDDto) {
    return this.inventoryService.getUnitById(id);
  }

  @Patch('units/:id')
  @RequirePermissions(PermissionKeys.INVENTORY_UPDATE)
  updateUnit(
    @Param() { id }: IDDto,
    @Employee('employeeId') employeeId: string,
    @Body() dto: UpdateUnitDto,
  ) {
    return this.inventoryService.updateUnit(id, employeeId, dto);
  }

  @Delete('units/:id')
  @RequirePermissions(PermissionKeys.INVENTORY_DELETE)
  deleteUnit(
    @Param() { id }: IDDto,
    @Employee('employeeId') employeeId: string,
  ) {
    return this.inventoryService.deleteUnit(id, employeeId);
  }

  @Post('items')
  @RequirePermissions(PermissionKeys.INVENTORY_CREATE)
  createItem(
    @Employee('employeeId') employeeId: string,
    @Body() dto: CreateInventoryItemDto,
  ) {
    return this.inventoryService.createItem(employeeId, dto);
  }

  @Get('items')
  @RequirePermissions(PermissionKeys.INVENTORY_READ)
  getItems(@Query() query: GetInventoryItemsDto) {
    return this.inventoryService.getItems(query);
  }

  @Get('items/:id')
  @RequirePermissions(PermissionKeys.INVENTORY_READ)
  getItemById(@Param() { id }: IDDto) {
    return this.inventoryService.getItemById(id);
  }

  @Patch('items/:id')
  @RequirePermissions(PermissionKeys.INVENTORY_UPDATE)
  updateItem(
    @Param() { id }: IDDto,
    @Employee('employeeId') employeeId: string,
    @Body() dto: UpdateInventoryItemDto,
  ) {
    return this.inventoryService.updateItem(id, employeeId, dto);
  }

  @Delete('items/:id')
  @RequirePermissions(PermissionKeys.INVENTORY_DELETE)
  deleteItem(
    @Param() { id }: IDDto,
    @Employee('employeeId') employeeId: string,
  ) {
    return this.inventoryService.deleteItem(id, employeeId);
  }

  @Post('items/:id/import')
  @RequirePermissions(PermissionKeys.INVENTORY_UPDATE)
  importItem(
    @Param() { id }: IDDto,
    @Employee('employeeId') employeeId: string,
    @Body() dto: InventoryMovementDto,
  ) {
    return this.inventoryService.importItem(id, employeeId, dto);
  }

  @Post('items/:id/export')
  @RequirePermissions(PermissionKeys.INVENTORY_UPDATE)
  exportItem(
    @Param() { id }: IDDto,
    @Employee('employeeId') employeeId: string,
    @Body() dto: InventoryMovementDto,
  ) {
    return this.inventoryService.exportItem(id, employeeId, dto);
  }

  @Post('imports/bulk')
  @RequirePermissions(PermissionKeys.INVENTORY_UPDATE)
  bulkImport(
    @Employee('employeeId') employeeId: string,
    @Body() dto: BulkInventoryMovementDto,
  ) {
    return this.inventoryService.bulkImport(employeeId, dto);
  }

  @Post('exports/bulk')
  @RequirePermissions(PermissionKeys.INVENTORY_UPDATE)
  bulkExport(
    @Employee('employeeId') employeeId: string,
    @Body() dto: BulkInventoryMovementDto,
  ) {
    return this.inventoryService.bulkExport(employeeId, dto);
  }

  @Get('transactions')
  @RequirePermissions(PermissionKeys.INVENTORY_READ)
  getTransactions(@Query() query: GetInventoryTransactionsDto) {
    return this.inventoryService.getTransactions(query);
  }
}
