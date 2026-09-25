import { Injectable } from '@nestjs/common';
import {
  BulkInventoryExportDto,
  BulkInventoryImportDto,
  CancelPurchaseReceiptDto,
  CancelStocktakeDto,
  CreateInventoryCategoryDto,
  CreateInventoryItemDto,
  CreatePurchaseReceiptDto,
  CreateStocktakeDto,
  CreateSupplierDto,
  CreateUnitDto,
  GetInventoryCategoriesDto,
  GetInventoryItemsDto,
  GetInventoryReorderAlertsDto,
  GetInventoryTransactionsDto,
  GetInventoryWasteDto,
  GetPurchaseReceiptsDto,
  GetStocktakesDto,
  GetSuppliersDto,
  GetUnitsDto,
  InventoryExportDto,
  InventoryImportDto,
  PostPurchaseReceiptDto,
  PostStocktakeDto,
  UpdateInventoryCategoryDto,
  UpdateInventoryItemDto,
  UpdatePurchaseReceiptDto,
  UpdateStocktakeCountsDto,
  UpdateSupplierDto,
  UpdateUnitDto,
} from './dto';
import { InventoryCategoryService } from './services/inventory-category.service';
import { InventoryItemService } from './services/inventory-item.service';
import { InventoryMovementService } from './services/inventory-movement.service';
import { InventoryQueryService } from './services/inventory-query.service';
import { UnitService } from './services/unit.service';
import { PurchaseReceiptService } from './services/purchase-receipt.service';
import { StocktakeService } from './services/stocktake.service';
import { SupplierService } from './services/supplier.service';

@Injectable()
export class InventoryService {
  constructor(
    private readonly categoryService: InventoryCategoryService,
    private readonly unitService: UnitService,
    private readonly itemService: InventoryItemService,
    private readonly movementService: InventoryMovementService,
    private readonly queryService: InventoryQueryService,
    private readonly supplierService: SupplierService,
    private readonly purchaseReceiptService: PurchaseReceiptService,
    private readonly stocktakeService: StocktakeService,
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

  importItem(id: string, employeeId: string, dto: InventoryImportDto) {
    return this.movementService.importItem(id, employeeId, dto);
  }

  exportItem(id: string, employeeId: string, dto: InventoryExportDto) {
    return this.movementService.exportItem(id, employeeId, dto);
  }

  bulkImport(employeeId: string, dto: BulkInventoryImportDto) {
    return this.movementService.bulkImport(employeeId, dto);
  }

  bulkExport(employeeId: string, dto: BulkInventoryExportDto) {
    return this.movementService.bulkExport(employeeId, dto);
  }

  getTransactions(query: GetInventoryTransactionsDto) {
    return this.queryService.findTransactions(query);
  }

  getReorderAlerts(query: GetInventoryReorderAlertsDto) {
    return this.queryService.findReorderAlerts(query);
  }

  getWaste(query: GetInventoryWasteDto) {
    return this.queryService.findWaste(query);
  }

  createSupplier(employeeId: string, dto: CreateSupplierDto) {
    return this.supplierService.create(employeeId, dto);
  }

  getSuppliers(query: GetSuppliersDto) {
    return this.supplierService.findAll(query);
  }

  getSupplierById(id: string) {
    return this.supplierService.findOne(id);
  }

  updateSupplier(id: string, employeeId: string, dto: UpdateSupplierDto) {
    return this.supplierService.update(id, employeeId, dto);
  }

  deleteSupplier(id: string, employeeId: string) {
    return this.supplierService.remove(id, employeeId);
  }

  createPurchaseReceipt(employeeId: string, dto: CreatePurchaseReceiptDto) {
    return this.purchaseReceiptService.create(employeeId, dto);
  }

  getPurchaseReceipts(query: GetPurchaseReceiptsDto) {
    return this.purchaseReceiptService.findAll(query);
  }

  getPurchaseReceiptById(id: string) {
    return this.purchaseReceiptService.findOne(id);
  }

  updatePurchaseReceipt(
    id: string,
    employeeId: string,
    dto: UpdatePurchaseReceiptDto,
  ) {
    return this.purchaseReceiptService.update(id, employeeId, dto);
  }

  postPurchaseReceipt(
    id: string,
    employeeId: string,
    dto: PostPurchaseReceiptDto,
  ) {
    return this.purchaseReceiptService.post(id, employeeId, dto);
  }

  cancelPurchaseReceipt(
    id: string,
    employeeId: string,
    dto: CancelPurchaseReceiptDto,
  ) {
    return this.purchaseReceiptService.cancel(id, employeeId, dto);
  }

  createStocktake(employeeId: string, dto: CreateStocktakeDto) {
    return this.stocktakeService.create(employeeId, dto);
  }

  getStocktakes(query: GetStocktakesDto) {
    return this.stocktakeService.findAll(query);
  }

  getStocktakeById(id: string) {
    return this.stocktakeService.findOne(id);
  }

  updateStocktakeCounts(
    id: string,
    employeeId: string,
    dto: UpdateStocktakeCountsDto,
  ) {
    return this.stocktakeService.updateCounts(id, employeeId, dto);
  }

  postStocktake(id: string, employeeId: string, dto: PostStocktakeDto) {
    return this.stocktakeService.post(id, employeeId, dto);
  }

  cancelStocktake(id: string, employeeId: string, dto: CancelStocktakeDto) {
    return this.stocktakeService.cancel(id, employeeId, dto);
  }
}
