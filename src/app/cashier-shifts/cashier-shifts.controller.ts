import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { PermissionKeys } from '../../common/consts/permission-keys';
import { Employee } from '../../common/decorators/employee.decorator';
import { IDDto } from '../../common/dto/param.dto';
import { RequirePermissions } from '../authorization/authorization.decorator';
import { CashierShiftsService } from './cashier-shifts.service';
import {
  CloseCashierShiftDto,
  CreateCashMovementDto,
  GetCashierShiftsDto,
  OpenCashierShiftDto,
} from './dto';

@ApiTags('cashier-shifts')
@Controller('cashier-shifts')
export class CashierShiftsController {
  constructor(private readonly cashierShiftsService: CashierShiftsService) {}

  @Post('open')
  @RequirePermissions(PermissionKeys.CASHIER_SHIFTS_OPEN)
  open(
    @Employee('employeeId') employeeId: string,
    @Body() dto: OpenCashierShiftDto,
  ) {
    return this.cashierShiftsService.open(employeeId, dto);
  }

  @Get('current')
  @RequirePermissions(PermissionKeys.CASHIER_SHIFTS_CURRENT)
  getCurrent(@Employee('employeeId') employeeId: string) {
    return this.cashierShiftsService.getCurrent(employeeId);
  }

  @Post('current/transactions')
  @RequirePermissions(PermissionKeys.CASHIER_SHIFTS_TRANSACTIONS_CREATE)
  addMovement(
    @Employee('employeeId') employeeId: string,
    @Body() dto: CreateCashMovementDto,
  ) {
    return this.cashierShiftsService.addMovement(employeeId, dto);
  }

  @Post('current/close')
  @RequirePermissions(PermissionKeys.CASHIER_SHIFTS_CLOSE)
  close(
    @Employee('employeeId') employeeId: string,
    @Body() dto: CloseCashierShiftDto,
  ) {
    return this.cashierShiftsService.close(employeeId, dto);
  }

  @Get()
  @RequirePermissions(PermissionKeys.CASHIER_SHIFTS_READ)
  findAll(@Query() query: GetCashierShiftsDto) {
    return this.cashierShiftsService.findAll(query);
  }

  @Get(':id')
  @RequirePermissions(PermissionKeys.CASHIER_SHIFTS_READ)
  findOne(@Param() { id }: IDDto) {
    return this.cashierShiftsService.findOne(id);
  }
}
