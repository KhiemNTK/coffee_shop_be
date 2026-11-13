import { Body, Controller, Get, Header, Param, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { PermissionKeys } from '../../common/consts/permission-keys';
import { Employee } from '../../common/decorators/employee.decorator';
import { IDDto } from '../../common/dto/param.dto';
import { RequirePermissions } from '../authorization/authorization.decorator';
import { RevokeCustomerVoucherDto } from './dto/voucher.dto';
import { VouchersService } from './vouchers.service';

@ApiTags('Voucher Grants')
@Controller('voucher-grants')
export class VoucherGrantsController {
  constructor(private readonly vouchers: VouchersService) {}

  @Get(':id')
  @RequirePermissions(PermissionKeys.VOUCHERS_READ)
  @Header('Cache-Control', 'no-store')
  getGrant(@Param() { id }: IDDto) {
    return this.vouchers.getGrant(id);
  }

  @Post(':id/revoke')
  @RequirePermissions(PermissionKeys.VOUCHERS_REVOKE)
  @Header('Cache-Control', 'no-store')
  revoke(
    @Param() { id }: IDDto,
    @Employee('employeeId') employeeId: string,
    @Body() dto: RevokeCustomerVoucherDto,
  ) {
    return this.vouchers.revoke(id, employeeId, dto);
  }
}
