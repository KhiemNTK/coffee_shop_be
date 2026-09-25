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
  @RequirePermissions(PermissionKeys.INVENTORY_STOCK_ADJUST)
  importItem(
    @Param() { id }: IDDto,
    @Employee('employeeId') employeeId: string,
    @Body() dto: InventoryImportDto,
  ) {
    return this.inventoryService.importItem(id, employeeId, dto);
  }

  @Post('items/:id/export')
  @RequirePermissions(PermissionKeys.INVENTORY_STOCK_ADJUST)
  exportItem(
    @Param() { id }: IDDto,
    @Employee('employeeId') employeeId: string,
    @Body() dto: InventoryExportDto,
  ) {
    return this.inventoryService.exportItem(id, employeeId, dto);
  }

  @Post('imports/bulk')
  @RequirePermissions(PermissionKeys.INVENTORY_STOCK_ADJUST)
  bulkImport(
    @Employee('employeeId') employeeId: string,
    @Body() dto: BulkInventoryImportDto,
  ) {
    return this.inventoryService.bulkImport(employeeId, dto);
  }

  @Post('exports/bulk')
  @RequirePermissions(PermissionKeys.INVENTORY_STOCK_ADJUST)
  bulkExport(
    @Employee('employeeId') employeeId: string,
    @Body() dto: BulkInventoryExportDto,
  ) {
    return this.inventoryService.bulkExport(employeeId, dto);
  }

  @Get('transactions')
  @RequirePermissions(PermissionKeys.INVENTORY_READ)
  getTransactions(@Query() query: GetInventoryTransactionsDto) {
    return this.inventoryService.getTransactions(query);
  }

  @Get('reorder-alerts')
  @RequirePermissions(PermissionKeys.INVENTORY_READ)
  getReorderAlerts(@Query() query: GetInventoryReorderAlertsDto) {
    return this.inventoryService.getReorderAlerts(query);
  }

  @Get('waste')
  @RequirePermissions(PermissionKeys.INVENTORY_READ)
  getWaste(@Query() query: GetInventoryWasteDto) {
    return this.inventoryService.getWaste(query);
  }

  @Post('suppliers')
  @RequirePermissions(PermissionKeys.INVENTORY_SUPPLIERS_MANAGE)
  createSupplier(
    @Employee('employeeId') employeeId: string,
    @Body() dto: CreateSupplierDto,
  ) {
    return this.inventoryService.createSupplier(employeeId, dto);
  }

  @Get('suppliers')
  @RequirePermissions(PermissionKeys.INVENTORY_SUPPLIERS_READ)
  getSuppliers(@Query() query: GetSuppliersDto) {
    return this.inventoryService.getSuppliers(query);
  }

  @Get('suppliers/:id')
  @RequirePermissions(PermissionKeys.INVENTORY_SUPPLIERS_READ)
  getSupplierById(@Param() { id }: IDDto) {
    return this.inventoryService.getSupplierById(id);
  }

  @Patch('suppliers/:id')
  @RequirePermissions(PermissionKeys.INVENTORY_SUPPLIERS_MANAGE)
  updateSupplier(
    @Param() { id }: IDDto,
    @Employee('employeeId') employeeId: string,
    @Body() dto: UpdateSupplierDto,
  ) {
    return this.inventoryService.updateSupplier(id, employeeId, dto);
  }

  @Delete('suppliers/:id')
  @RequirePermissions(PermissionKeys.INVENTORY_SUPPLIERS_MANAGE)
  deleteSupplier(
    @Param() { id }: IDDto,
    @Employee('employeeId') employeeId: string,
  ) {
    return this.inventoryService.deleteSupplier(id, employeeId);
  }

  @Post('purchase-receipts')
  @RequirePermissions(PermissionKeys.INVENTORY_PURCHASE_RECEIPTS_CREATE)
  createPurchaseReceipt(
    @Employee('employeeId') employeeId: string,
    @Body() dto: CreatePurchaseReceiptDto,
  ) {
    return this.inventoryService.createPurchaseReceipt(employeeId, dto);
  }

  @Get('purchase-receipts')
  @RequirePermissions(PermissionKeys.INVENTORY_PURCHASE_RECEIPTS_READ)
  getPurchaseReceipts(@Query() query: GetPurchaseReceiptsDto) {
    return this.inventoryService.getPurchaseReceipts(query);
  }

  @Get('purchase-receipts/:id')
  @RequirePermissions(PermissionKeys.INVENTORY_PURCHASE_RECEIPTS_READ)
  getPurchaseReceiptById(@Param() { id }: IDDto) {
    return this.inventoryService.getPurchaseReceiptById(id);
  }

  @Patch('purchase-receipts/:id')
  @RequirePermissions(PermissionKeys.INVENTORY_PURCHASE_RECEIPTS_CREATE)
  updatePurchaseReceipt(
    @Param() { id }: IDDto,
    @Employee('employeeId') employeeId: string,
    @Body() dto: UpdatePurchaseReceiptDto,
  ) {
    return this.inventoryService.updatePurchaseReceipt(id, employeeId, dto);
  }

  @Post('purchase-receipts/:id/post')
  @RequirePermissions(PermissionKeys.INVENTORY_PURCHASE_RECEIPTS_POST)
  postPurchaseReceipt(
    @Param() { id }: IDDto,
    @Employee('employeeId') employeeId: string,
    @Body() dto: PostPurchaseReceiptDto,
  ) {
    return this.inventoryService.postPurchaseReceipt(id, employeeId, dto);
  }

  @Post('purchase-receipts/:id/cancel')
  @RequirePermissions(PermissionKeys.INVENTORY_PURCHASE_RECEIPTS_CREATE)
  cancelPurchaseReceipt(
    @Param() { id }: IDDto,
    @Employee('employeeId') employeeId: string,
    @Body() dto: CancelPurchaseReceiptDto,
  ) {
    return this.inventoryService.cancelPurchaseReceipt(id, employeeId, dto);
  }

  @Post('stocktakes')
  @RequirePermissions(PermissionKeys.INVENTORY_STOCKTAKES_CREATE)
  createStocktake(
    @Employee('employeeId') employeeId: string,
    @Body() dto: CreateStocktakeDto,
  ) {
    return this.inventoryService.createStocktake(employeeId, dto);
  }

  @Get('stocktakes')
  @RequirePermissions(PermissionKeys.INVENTORY_STOCKTAKES_READ)
  getStocktakes(@Query() query: GetStocktakesDto) {
    return this.inventoryService.getStocktakes(query);
  }

  @Get('stocktakes/:id')
  @RequirePermissions(PermissionKeys.INVENTORY_STOCKTAKES_READ)
  getStocktakeById(@Param() { id }: IDDto) {
    return this.inventoryService.getStocktakeById(id);
  }

  @Put('stocktakes/:id/counts')
  @RequirePermissions(PermissionKeys.INVENTORY_STOCKTAKES_CREATE)
  updateStocktakeCounts(
    @Param() { id }: IDDto,
    @Employee('employeeId') employeeId: string,
    @Body() dto: UpdateStocktakeCountsDto,
  ) {
    return this.inventoryService.updateStocktakeCounts(id, employeeId, dto);
  }

  @Post('stocktakes/:id/post')
  @RequirePermissions(PermissionKeys.INVENTORY_STOCKTAKES_POST)
  postStocktake(
    @Param() { id }: IDDto,
    @Employee('employeeId') employeeId: string,
    @Body() dto: PostStocktakeDto,
  ) {
    return this.inventoryService.postStocktake(id, employeeId, dto);
  }

  @Post('stocktakes/:id/cancel')
  @RequirePermissions(PermissionKeys.INVENTORY_STOCKTAKES_CREATE)
  cancelStocktake(
    @Param() { id }: IDDto,
    @Employee('employeeId') employeeId: string,
    @Body() dto: CancelStocktakeDto,
  ) {
    return this.inventoryService.cancelStocktake(id, employeeId, dto);
  }
}
