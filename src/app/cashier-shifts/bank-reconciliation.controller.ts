import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { PermissionKeys } from '../../common/consts/permission-keys';
import { Employee } from '../../common/decorators/employee.decorator';
import { IDDto } from '../../common/dto/param.dto';
import { RequirePermissions } from '../authorization/authorization.decorator';
import { BankReconciliationService } from './bank-reconciliation.service';
import {
  CreateBankStatementImportDto,
  GetBankStatementEntriesDto,
  GetBankStatementImportsDto,
  IgnoreBankStatementEntryDto,
} from './dto';

@ApiTags('bank-reconciliation')
@Controller('bank-reconciliation')
export class BankReconciliationController {
  constructor(
    private readonly bankReconciliationService: BankReconciliationService,
  ) {}

  @Post('imports')
  @RequirePermissions(PermissionKeys.BANK_RECONCILIATION_IMPORT)
  createImport(
    @Employee('employeeId') employeeId: string,
    @Body() dto: CreateBankStatementImportDto,
  ) {
    return this.bankReconciliationService.createImport(employeeId, dto);
  }

  @Get('imports')
  @RequirePermissions(PermissionKeys.BANK_RECONCILIATION_READ)
  findImports(@Query() query: GetBankStatementImportsDto) {
    return this.bankReconciliationService.findImports(query);
  }

  @Get('imports/:id')
  @RequirePermissions(PermissionKeys.BANK_RECONCILIATION_READ)
  findImport(@Param() { id }: IDDto) {
    return this.bankReconciliationService.findImport(id);
  }

  @Post('imports/:id/reconcile')
  @RequirePermissions(PermissionKeys.BANK_RECONCILIATION_MANAGE)
  reconcile(
    @Param() { id }: IDDto,
    @Employee('employeeId') employeeId: string,
  ) {
    return this.bankReconciliationService.reconcile(id, employeeId);
  }

  @Get('entries')
  @RequirePermissions(PermissionKeys.BANK_RECONCILIATION_READ)
  findEntries(@Query() query: GetBankStatementEntriesDto) {
    return this.bankReconciliationService.findEntries(query);
  }

  @Post('entries/:id/ignore')
  @RequirePermissions(PermissionKeys.BANK_RECONCILIATION_MANAGE)
  ignoreEntry(
    @Param() { id }: IDDto,
    @Employee('employeeId') employeeId: string,
    @Body() dto: IgnoreBankStatementEntryDto,
  ) {
    return this.bankReconciliationService.ignoreEntry(id, employeeId, dto);
  }
}
