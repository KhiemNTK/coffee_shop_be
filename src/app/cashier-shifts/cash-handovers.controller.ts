import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { PermissionKeys } from '../../common/consts/permission-keys';
import { Employee } from '../../common/decorators/employee.decorator';
import { IDDto } from '../../common/dto/param.dto';
import { RequirePermissions } from '../authorization/authorization.decorator';
import { CashHandoversService } from './cash-handovers.service';
import {
  ApproveCashHandoverDto,
  CreateCashHandoverDto,
  GetCashHandoversDto,
  RejectCashHandoverDto,
} from './dto';

@ApiTags('cash-handovers')
@Controller('cash-handovers')
export class CashHandoversController {
  constructor(private readonly cashHandoversService: CashHandoversService) {}

  @Post()
  @RequirePermissions(PermissionKeys.CASH_HANDOVERS_CREATE)
  create(
    @Employee('employeeId') employeeId: string,
    @Body() dto: CreateCashHandoverDto,
  ) {
    return this.cashHandoversService.create(employeeId, dto);
  }

  @Get('mine')
  @RequirePermissions(PermissionKeys.CASH_HANDOVERS_CREATE)
  findMine(
    @Employee('employeeId') employeeId: string,
    @Query() query: GetCashHandoversDto,
  ) {
    return this.cashHandoversService.findAll(query, employeeId);
  }

  @Get()
  @RequirePermissions(PermissionKeys.CASH_HANDOVERS_READ)
  findAll(@Query() query: GetCashHandoversDto) {
    return this.cashHandoversService.findAll(query);
  }

  @Get(':id')
  @RequirePermissions(PermissionKeys.CASH_HANDOVERS_READ)
  findOne(@Param() { id }: IDDto) {
    return this.cashHandoversService.findOne(id);
  }

  @Post(':id/approve')
  @RequirePermissions(PermissionKeys.CASH_HANDOVERS_REVIEW)
  approve(
    @Param() { id }: IDDto,
    @Employee('employeeId') employeeId: string,
    @Body() dto: ApproveCashHandoverDto,
  ) {
    return this.cashHandoversService.approve(id, employeeId, dto);
  }

  @Post(':id/reject')
  @RequirePermissions(PermissionKeys.CASH_HANDOVERS_REVIEW)
  reject(
    @Param() { id }: IDDto,
    @Employee('employeeId') employeeId: string,
    @Body() dto: RejectCashHandoverDto,
  ) {
    return this.cashHandoversService.reject(id, employeeId, dto);
  }

  @Post(':id/cancel')
  @RequirePermissions(PermissionKeys.CASH_HANDOVERS_CREATE)
  cancel(@Param() { id }: IDDto, @Employee('employeeId') employeeId: string) {
    return this.cashHandoversService.cancel(id, employeeId);
  }
}
