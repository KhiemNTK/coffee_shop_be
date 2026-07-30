import { Injectable } from '@nestjs/common';
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
import { InventoryCategoryService } from './services/inventory-category.service';
import { InventoryItemService } from './services/inventory-item.service';
import { InventoryMovementService } from './services/inventory-movement.service';
import { InventoryQueryService } from './services/inventory-query.service';
import { UnitService } from './services/unit.service';

@Injectable()
export class InventoryService {
  constructor(
    private readonly categoryService: InventoryCategoryService,
    private readonly unitService: UnitService,
    private readonly itemService: InventoryItemService,
    private readonly movementService: InventoryMovementService,
    private readonly queryService: InventoryQueryService,
  ) {}

  createCategory(employeeId: string, dto: CreateInventoryCategoryDto) {
    return this.categoryService.create(employeeId, dto);
  }

  getCategories(query: GetInventoryCategoriesDto) {
    return this.categoryService.findAll(query);
  }

  getCategoryById(id: string) {
    return this.categoryService.findOne(id);
  }

  updateCategory(
    id: string,
    employeeId: string,
    dto: UpdateInventoryCategoryDto,
  ) {
    return this.categoryService.update(id, employeeId, dto);
  }

  deleteCategory(id: string, employeeId: string) {
    return this.categoryService.remove(id, employeeId);
  }

  createUnit(employeeId: string, dto: CreateUnitDto) {
    return this.unitService.create(employeeId, dto);
  }

  getUnits(query: GetUnitsDto) {
    return this.unitService.findAll(query);
  }

  getUnitById(id: string) {
    return this.unitService.findOne(id);
  }

  updateUnit(id: string, employeeId: string, dto: UpdateUnitDto) {
    return this.unitService.update(id, employeeId, dto);
  }

  deleteUnit(id: string, employeeId: string) {
    return this.unitService.remove(id, employeeId);
  }

  createItem(employeeId: string, dto: CreateInventoryItemDto) {
    return this.itemService.create(employeeId, dto);
  }

  getItems(query: GetInventoryItemsDto) {
    return this.queryService.findItems(query);
  }

  getItemById(id: string) {
    return this.itemService.findOne(id);
  }

  updateItem(id: string, employeeId: string, dto: UpdateInventoryItemDto) {
    return this.itemService.update(id, employeeId, dto);
  }

  deleteItem(id: string, employeeId: string) {
    return this.itemService.remove(id, employeeId);
  }

  importItem(id: string, employeeId: string, dto: InventoryMovementDto) {
    return this.movementService.importItem(id, employeeId, dto);
  }

  exportItem(id: string, employeeId: string, dto: InventoryMovementDto) {
    return this.movementService.exportItem(id, employeeId, dto);
  }

  bulkImport(employeeId: string, dto: BulkInventoryMovementDto) {
    return this.movementService.bulkImport(employeeId, dto);
  }

  bulkExport(employeeId: string, dto: BulkInventoryMovementDto) {
    return this.movementService.bulkExport(employeeId, dto);
  }

  getTransactions(query: GetInventoryTransactionsDto) {
    return this.queryService.findTransactions(query);
  }
}
