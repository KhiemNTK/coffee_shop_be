import {
  Body,
  Controller,
  Get,
  Header,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { PermissionKeys } from '../../common/consts/permission-keys';
import { Employee } from '../../common/decorators/employee.decorator';
import { IDDto } from '../../common/dto/param.dto';
import { SkipAuth } from '../auth/auth.decorator';
import { RequirePermissions } from '../authorization/authorization.decorator';
import {
  CreateVoucherCampaignDto,
  GetPublicVoucherCampaignsDto,
  GetVoucherCampaignsDto,
  GetVoucherGrantsDto,
  GiftCustomerVoucherDto,
  UpdateVoucherCampaignDto,
  VoucherCampaignVersionDto,
} from './dto/voucher.dto';
import { VoucherCampaignsService } from './voucher-campaigns.service';
import { VouchersService } from './vouchers.service';

@ApiTags('Voucher Campaigns')
@Controller('voucher-campaigns')
export class VoucherCampaignsController {
  constructor(
    private readonly campaigns: VoucherCampaignsService,
    private readonly vouchers: VouchersService,
  ) {}

  @Get('public')
  @SkipAuth()
  @Header('Cache-Control', 'no-store')
  getPublicCampaigns(@Query() query: GetPublicVoucherCampaignsDto) {
    return this.campaigns.getPublicCampaigns(query);
  }

  @Get()
  @RequirePermissions(PermissionKeys.VOUCHERS_READ)
  findAll(@Query() query: GetVoucherCampaignsDto) {
    return this.campaigns.findAll(query);
  }

  @Post()
  @RequirePermissions(PermissionKeys.VOUCHERS_MANAGE)
  create(
    @Employee('employeeId') employeeId: string,
    @Body() dto: CreateVoucherCampaignDto,
  ) {
    return this.campaigns.create(employeeId, dto);
  }

  @Get(':id/grants')
  @RequirePermissions(PermissionKeys.VOUCHERS_READ)
  @Header('Cache-Control', 'no-store')
  getGrants(@Param() { id }: IDDto, @Query() query: GetVoucherGrantsDto) {
    return this.vouchers.getGrants(id, query);
  }

  @Post(':id/grants')
  @RequirePermissions(PermissionKeys.VOUCHERS_ISSUE)
  gift(
    @Param() { id }: IDDto,
    @Employee('employeeId') employeeId: string,
    @Body() dto: GiftCustomerVoucherDto,
  ) {
    return this.vouchers.gift(id, employeeId, dto);
  }

  @Get(':id')
  @RequirePermissions(PermissionKeys.VOUCHERS_READ)
  findOne(@Param() { id }: IDDto) {
    return this.campaigns.findOne(id);
  }

  @Patch(':id')
  @RequirePermissions(PermissionKeys.VOUCHERS_MANAGE)
  update(
    @Param() { id }: IDDto,
    @Employee('employeeId') employeeId: string,
    @Body() dto: UpdateVoucherCampaignDto,
  ) {
    return this.campaigns.update(id, employeeId, dto);
  }

  @Post(':id/publish')
  @RequirePermissions(PermissionKeys.VOUCHERS_MANAGE)
  publish(
    @Param() { id }: IDDto,
    @Employee('employeeId') employeeId: string,
    @Body() dto: VoucherCampaignVersionDto,
  ) {
    return this.campaigns.publish(id, employeeId, dto);
  }

  @Post(':id/pause')
  @RequirePermissions(PermissionKeys.VOUCHERS_MANAGE)
  pause(
    @Param() { id }: IDDto,
    @Employee('employeeId') employeeId: string,
    @Body() dto: VoucherCampaignVersionDto,
  ) {
    return this.campaigns.pause(id, employeeId, dto);
  }
}
